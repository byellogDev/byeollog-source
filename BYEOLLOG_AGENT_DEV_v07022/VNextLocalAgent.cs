namespace HurogiCollector;

internal sealed record VNextLocalAgentStatus(
    bool Running,
    bool Connected,
    string State,
    int PendingAcks,
    int Uncertain,
    bool OverlayAssetsReady,
    int ManagedOverlayAssets,
    DateTimeOffset? OverlayManifestGeneratedAt,
    string LastError);

internal sealed record VNextLocalAgentPreflight(
    bool Running,
    bool Connected,
    bool DeviceRegistered,
    DateTimeOffset? LastDeviceStatusAt,
    bool DatabaseIntegrityOk,
    bool DatabaseForeignKeysOk,
    int DatabaseSchemaVersion,
    int PendingAcks,
    int Uncertain,
    int Succeeded,
    bool OverlayLoopbackRunning,
    bool RequiredAssetsReady,
    int ExactAssetsReady,
    bool BuiltInAssetExact,
    DateTimeOffset? ManifestGeneratedAt,
    bool TimedMuteRecoveryPending);

internal sealed record VNextLocalOverlayDiagnostics(
    bool OverlayRunning,
    OverlayAssetCacheStatus Cache,
    IReadOnlyList<VNextReadyOverlayAsset> ReadyRevisions,
    bool BuiltInAssetExact);

internal sealed record VNextRaffleSpeechPrewarmResult(
    int TotalCandidates,
    int Prepared,
    int Reused,
    int Failed,
    bool Truncated);

internal sealed class VNextLocalAgent : IDisposable
{
    private const int LeaseSeconds = 45;
    private const int MaximumConcurrentExecutions = 4;
    private const string AgentVersion = BuildInfo.Version;

    private sealed class ExecutionSlotLease
    {
        private readonly SemaphoreSlim _slots;
        private readonly Action _wake;
        private int _released;

        public ExecutionSlotLease(SemaphoreSlim slots, Action wake)
        {
            _slots = slots;
            _wake = wake;
        }

        public void Release()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            _slots.Release();
            _wake();
        }
    }
    // Realtime is the hot path. The durable execution queue and local ACK outbox
    // remain authoritative; these intervals are only liveness/recovery fences.
    // A connected Agent therefore does not poll continuously while idle.
    // The authoritative claim RPC requires an exact capability report newer
    // than five minutes. Four minutes leaves clock/network margin while this
    // heartbeat now travels through the low-cost direct PostgREST path.
    private static readonly TimeSpan DeviceStatusInterval = TimeSpan.FromMinutes(4);
    private static readonly TimeSpan OverlayAssetSyncInterval = TimeSpan.FromHours(6);
    // A missed Realtime wake must not leave a live donation/action dormant.
    // This is a lightweight authoritative pending probe, not a full claim or
    // asset poll; normal Realtime delivery still executes immediately.
    private static readonly TimeSpan RealtimeConnectedRecoveryInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RealtimeDisconnectedClaimFallback = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan WallpaperSyncInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan DeviceSecretRotationInterval = TimeSpan.FromDays(90);
    private readonly VNextDevelopmentClient _client;
    private readonly VNextRealtimeWakeListener _wakeListener;
    private readonly CollectorStorage _collectorStorage;
    private readonly VNextAgentStore _store;
    private readonly ObsActionAdapter _obsActions;
    private readonly OverlayAssetCache _overlayAssets;
    private readonly WallpaperOverlayState _wallpaper;
    private readonly ByeollogOverlayService _overlay;
    private readonly TimedMuteActionAdapter _timedMuteActions;
    private readonly RaffleOverlayActionAdapter _raffleOverlayActions;
    private readonly FlashbangOverlayActionAdapter _flashbangOverlayActions;
    private readonly ScreenActionAdapter _screenActions;
    private readonly VisualEffectOverlayActionAdapter _visualEffectActions;
    private readonly string _deviceId;
    private string _deviceSecret;
    private string? _pendingDeviceSecret;
    private long _deviceSecretRevision;
    private DateTimeOffset? _deviceSecretRotatedAt;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _wakeSignal = new(0, 1);
    private readonly SemaphoreSlim _registrationGate = new(1, 1);
    private readonly SemaphoreSlim _overlayAssetSyncGate = new(1, 1);
    private readonly SemaphoreSlim _wallpaperFetchGate = new(1, 1);
    private readonly SemaphoreSlim _wallpaperSyncGate = new(1, 1);
    private readonly SemaphoreSlim _displayObservationGate = new(1, 1);
    private readonly SemaphoreSlim _outboxFlushGate = new(1, 1);
    private readonly SemaphoreSlim _executionSlots = new(MaximumConcurrentExecutions, MaximumConcurrentExecutions);
    private readonly WallpaperSyncRequestTracker _wallpaperRequests = new();
    private readonly object _executionGate = new();
    private readonly HashSet<Task> _inflightExecutions = [];
    private readonly object _statusGate = new();
    private Task? _loop;
    private DateTimeOffset _nextWallpaperSyncAtUtc = DateTimeOffset.MinValue;
    private VNextLocalAgentStatus _status = new(false, false, "중지됨", 0, 0, true, 0, null, "");
    private bool _disposed;
    private bool _deviceRegistered;
    private DateTimeOffset? _lastDeviceStatusAt;
    private int _startupOverlayRefreshPending = 1;
    private DateTimeOffset _nextOverlayAssetSyncAt = DateTimeOffset.MinValue;
    private DateTimeOffset _nextDeviceStatusAt = DateTimeOffset.MinValue;
    private int _resourcesDisposed;
    private int _executionClaimRequested = 1;
    private int _pendingDisplayObservations;

    public VNextLocalAgent(VNextDevelopmentClient client, CollectorStorage collectorStorage)
    {
        _client = client;
        _collectorStorage = collectorStorage;
        _wakeListener = new VNextRealtimeWakeListener(
            client.GetRealtimeCredentialsAsync,
            RequestExecutionClaim,
            RequestWallpaperSync,
            collectorStorage.Log);
        var databasePath = Path.Combine(collectorStorage.RootPath, "vnext_agent.sqlite");
        _store = new VNextAgentStore(databasePath);
        try
        {
            _deviceId = _store.GetOrCreateDeviceId();
            var credentials = collectorStorage.LoadOrCreateVNextAgentCredentials();
            _deviceSecret = credentials.DeviceSecret;
            _pendingDeviceSecret = credentials.PendingDeviceSecret;
            _deviceSecretRevision = credentials.SecretRevision;
            _deviceSecretRotatedAt = credentials.RotatedAt;
            _obsActions = new ObsActionAdapter(collectorStorage);
            _overlayAssets = new OverlayAssetCache(
                Path.Combine(collectorStorage.RootPath, "overlay-assets"),
                collectorStorage.Log);
            _wallpaper = new WallpaperOverlayState(
                collectorStorage.RootPath,
                collectorStorage.Log,
                handler: null,
                authenticatedDownloader: _client.DownloadAuthenticatedWallpaperImageAsync);
            _overlay = new ByeollogOverlayService(collectorStorage, _overlayAssets, _wallpaper);
            _overlay.DisplayObserved += QueueDisplayObservation;
            _overlay.TryStart();
            _timedMuteActions = new TimedMuteActionAdapter(collectorStorage, _overlay);
            _raffleOverlayActions = new RaffleOverlayActionAdapter(
                _overlay,
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        ? await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token)
                        : 0;
                },
                async (executionId, attemptNo, _, token) =>
                {
                    var download = await _client.DownloadRaffleActionSpeechAsync(
                        _deviceId,
                        _deviceSecret,
                        executionId,
                        attemptNo,
                        "ticket",
                        0,
                        RaffleOverlayActionAdapter.TicketAudioBindingKey,
                        token);
                    return new RafflePreparedAudio(
                        download.Audio,
                        download.AudioSha256,
                        download.VoiceKey,
                        "managed_donation_tts",
                        null);
                },
                async (executionId, attemptNo, winnerOrdinal, expectedVoiceKey, volumePercent, token) =>
                {
                    var download = await _client.DownloadRaffleActionSpeechAsync(
                        _deviceId,
                        _deviceSecret,
                        executionId,
                        attemptNo,
                        "winner",
                        winnerOrdinal,
                        expectedVoiceKey,
                        token);
                    return new RafflePreparedAudio(
                        download.Audio,
                        download.AudioSha256,
                        download.VoiceKey,
                        "managed_donation_tts",
                        null);
                },
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        && await ObsActionAdapter.EnsureOverlayBrowserAudioRoutingAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token) > 0;
                },
                collectorStorage.Log);
            _flashbangOverlayActions = new FlashbangOverlayActionAdapter(
                _overlay,
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        ? await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token)
                        : 0;
                },
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        && await ObsActionAdapter.EnsureOverlayBrowserAudioRoutingAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token) > 0;
                },
                collectorStorage.Log);
            _screenActions = new ScreenActionAdapter(
                collectorStorage,
                _overlay,
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        ? await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token)
                        : 0;
                },
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        && await ObsActionAdapter.EnsureOverlayBrowserAudioRoutingAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token) > 0;
                },
                collectorStorage.Log);
            _visualEffectActions = new VisualEffectOverlayActionAdapter(
                _overlay,
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        ? await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token)
                        : 0;
                },
                async token =>
                {
                    var settings = collectorStorage.LoadObsSettings();
                    return settings.Enabled
                        && await ObsActionAdapter.EnsureOverlayBrowserAudioRoutingAsync(
                            settings,
                            _overlay.OverlayUrl,
                            token) > 0;
                },
                collectorStorage.Log);
        }
        catch
        {
            _wakeListener.Dispose();
            _store.Dispose();
            throw;
        }
        _client.SessionChanged += Client_SessionChanged;
        Publish(false, "시작 대기", "");
    }

    public event EventHandler? StatusChanged;

    public string DeviceId => _deviceId;
    public string OverlayUrl => _overlay.OverlayUrl;
    public string WallpaperOverlayUrl => _overlay.WallpaperOverlayUrl;

    public bool OverlayAvailable => _overlay.IsRunning;
    public OverlayAssetCacheStatus OverlayAssetStatus => _overlayAssets.Status();
    public IReadOnlyList<VNextOverlayAssetDescriptor> PackagedOverlayImages() =>
        _overlayAssets.PackagedImageDescriptors();

    public async Task<(int ActionSources, int WallpaperSources)> RefreshObsOverlaySourcesAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var settings = _collectorStorage.LoadObsSettings();
        if (!settings.Enabled)
            throw new InvalidOperationException(
                "OBS 연결 설정을 먼저 켜야 별록 오버레이 소스를 자동 확인할 수 있습니다.");

        var actionSources = await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
            settings,
            _overlay.OverlayUrl,
            cancellationToken);
        var wallpaperSources = await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
            settings,
            _overlay.WallpaperOverlayUrl,
            cancellationToken);
        _collectorStorage.Log(
            $"OBS 로컬 오버레이 새로고침 · action={actionSources} · wallpaper={wallpaperSources}");
        return (actionSources, wallpaperSources);
    }

#if false // Retired: raffle speech now uses donation-alert managed TTS on demand.
    public async Task<VNextRaffleSpeechPrewarmResult> PrewarmRaffleWinnerSpeechAsync(
        string drawId,
        Func<int, int, Task>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (!Guid.TryParseExact(drawId, "D", out var parsedDrawId))
            throw new VNextDevelopmentException(
                "추첨 후보 음성 준비 식별값이 올바르지 않습니다.",
                code: "invalid_raffle_speech_request");

        const int maximumCandidates = 500;
        await _raffleSpeechPrewarmGate.WaitAsync(cancellationToken);
        try
        {
            var seenActorKeys = new HashSet<string>(StringComparer.Ordinal);
            var seenCursors = new HashSet<string>(StringComparer.Ordinal);
            string? cursor = null;
            int? expectedTotal = null;
            var prepared = 0;
            var reused = 0;
            var failed = 0;
            var processed = 0;
            var truncated = false;

            while (processed < maximumCandidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var batch = await _client.ListRaffleTtsCandidatesAsync(
                    _deviceId,
                    _deviceSecret,
                    parsedDrawId.ToString("D"),
                    cursor,
                    Math.Min(25, maximumCandidates - processed),
                    cancellationToken);
                expectedTotal ??= batch.TotalCount;
                if (batch.TotalCount != expectedTotal.Value)
                    throw new VNextDevelopmentException(
                        "추첨 후보 목록이 준비 중 변경되었습니다.",
                        code: "raffle_candidate_snapshot_changed");

                foreach (var candidate in batch.Candidates)
                {
                    if (!seenActorKeys.Add(candidate.ActorKey))
                        throw new VNextDevelopmentException(
                            "추첨 후보 목록에 중복 식별자가 있습니다.",
                            code: "invalid_raffle_speech_response");
                    try
                    {
                        if (_raffleWinnerSpeechCache.TryRead(candidate.VoiceKey, out _))
                        {
                            reused++;
                        }
                        else
                        {
                            var download = await _client.DownloadRaffleCandidateSpeechAsync(
                                _deviceId,
                                _deviceSecret,
                                parsedDrawId.ToString("D"),
                                candidate.ActorKey,
                                candidate.VoiceKey,
                                cancellationToken);
                            await _raffleWinnerSpeechCache.StoreAsync(
                                candidate.VoiceKey,
                                download,
                                cancellationToken);
                            prepared++;
                        }
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        failed++;
                        _collectorStorage.Log(
                            "당첨 후보 음성 준비 보류 · key=" + candidate.VoiceKey[..12]
                            + " · type=" + ex.GetType().Name);
                    }
                    processed++;
                    if (progress is not null)
                        await progress(processed, Math.Min(expectedTotal.Value, maximumCandidates));
                }

                if (processed >= expectedTotal.Value || batch.NextCursor is null) break;
                if (!seenCursors.Add(batch.NextCursor))
                    throw new VNextDevelopmentException(
                        "추첨 후보 목록 페이지가 반복되었습니다.",
                        code: "invalid_raffle_speech_response");
                cursor = batch.NextCursor;
                if (batch.Candidates.Count == 0) break;
            }

            if (expectedTotal is null)
                throw new VNextDevelopmentException(
                    "추첨 후보 목록을 불러오지 못했습니다.",
                    code: "invalid_raffle_speech_response");
            truncated = processed < expectedTotal.Value;
            return new VNextRaffleSpeechPrewarmResult(
                expectedTotal.Value,
                prepared,
                reused,
                failed,
                truncated);
        }
        finally
        {
            _raffleSpeechPrewarmGate.Release();
        }
    }

#endif
    public VNextLocalAgentStatus Status
    {
        get { lock (_statusGate) return _status; }
    }

    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_loop is not null) return;
        _wallpaperRequests.Request();
        _wakeListener.Start();
        _loop = Task.Run(() => RunAsync(_stop.Token));
        Publish(false, "연결 중", "");
    }

    private void RequestExecutionClaim()
    {
        Interlocked.Exchange(ref _executionClaimRequested, 1);
        Wake();
    }

    public void Wake()
    {
        if (_disposed || _stop.IsCancellationRequested) return;
        if (_wakeSignal.CurrentCount == 0)
        {
            try { _wakeSignal.Release(); }
            catch (ObjectDisposedException) { }
            catch (SemaphoreFullException) { }
        }
    }

    public Task PreviewOverlayAsync(
        int durationMs = 3_000,
        CancellationToken cancellationToken = default) =>
        _overlay.PreviewAsync(
            ByeollogOverlayService.MicrophoneOffAssetKey,
            durationMs,
            expectedAsset: null,
            cancellationToken: cancellationToken);

    public Task<bool> PreviewOverlayAssetAsync(
        string assetId,
        string expectedContentSha256,
        int durationMs = 3_000,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_overlayAssets.TryResolveByAssetId(assetId, expectedContentSha256, out var asset))
            throw new InvalidOperationException("선택한 오버레이 이미지가 이 PC에 준비되지 않았습니다. 에이전트를 다시 시작해주세요.");
        return _overlay.PreviewAsync(
            asset.AssetKey,
            durationMs,
            asset,
            cancellationToken);
    }

    public string? TryCreateOverlayPreviewDataUrl(string assetId, string expectedContentSha256)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        try
        {
            if (!_overlayAssets.TryResolveByAssetId(assetId, expectedContentSha256, out var descriptor))
                return null;
            var content = _overlayAssets.Read(descriptor);
            if (content.Bytes.Length > 4 * 1024 * 1024) return null;
            return $"data:{content.MimeType};base64,{Convert.ToBase64String(content.Bytes)}";
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            _collectorStorage.Log("Overlay setup preview unavailable: " + ex.GetType().Name);
            return null;
        }
    }

    public async Task<VNextLocalOverlayDiagnostics> CreateOverlayDiagnosticsAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var readyRevisions = await _overlayAssets.ReadyRevisionsAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var cache = _overlayAssets.Status();
        var builtInExact = readyRevisions.Any(item =>
            string.Equals(item.AssetId, OverlayAssetCache.BuiltInAssetId, StringComparison.OrdinalIgnoreCase)
            && string.Equals(item.ContentSha256, OverlayAssetCache.BuiltInContentSha256, StringComparison.Ordinal));
        return new VNextLocalOverlayDiagnostics(
            _overlay.IsRunning,
            cache,
            readyRevisions,
            builtInExact);
    }

    public async Task EnsureCurrentDeviceRegisteredAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await EnsureDeviceRegisteredAsync(cancellationToken);
        await ReportDeviceStatusAsync(force: true, cancellationToken);
        Publish(true, "장치 등록·기능 확인 완료", "");
    }

    public async Task<OverlayAssetCacheSyncResult> SyncOverlayAssetsNowAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await EnsureDeviceRegisteredAsync(cancellationToken);
        var result = await SyncOverlayAssetsAsync(force: true, cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("오버레이 이미지 확인 결과가 없습니다.");
        if (!_overlayAssets.RequiredReady())
            throw new InvalidOperationException("필수 오버레이 이미지가 모두 준비되지 않았습니다.");
        await ReportDeviceStatusAsync(force: true, cancellationToken);
        Publish(true, "오버레이 이미지 확인 완료", "");
        return result;
    }

    public async Task<VNextLocalAgentPreflight> CreatePreflightAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var health = _store.Health();
        var overlay = await CreateOverlayDiagnosticsAsync(cancellationToken);
        var agentStatus = Status;
        return new VNextLocalAgentPreflight(
            agentStatus.Running,
            agentStatus.Connected,
            _deviceRegistered,
            _lastDeviceStatusAt,
            health.IntegrityOk,
            health.ForeignKeysOk,
            health.SchemaVersion,
            health.PendingAcks,
            health.Uncertain,
            health.Succeeded,
            overlay.OverlayRunning,
            overlay.Cache.RequiredReady,
            overlay.ReadyRevisions.Count,
            overlay.BuiltInAssetExact,
            overlay.Cache.ManifestGeneratedAt,
            _timedMuteActions.HasPendingRecovery());
    }

    public VNextAgentExecutionEvidence? FindFirstObsTimedMuteSince(DateTimeOffset sinceUtc) =>
        _store.FindFirstObsTimedMuteSince(sinceUtc);

    public ByeollogOverlayTelemetrySnapshot OverlayTelemetry() => _overlay.Telemetry();

    public Task<ObsVoiceAnonymizerStatus> ProbeVoiceAnonymizerAsync(
        string preset,
        CancellationToken cancellationToken = default) =>
        _timedMuteActions.ProbeVoiceAnonymizerAsync(preset, cancellationToken);

    public Task<TimedMuteRunResult> PreviewVoiceAnonymizerAsync(
        string preset,
        CancellationToken cancellationToken = default) =>
        _timedMuteActions.RunLocalVoiceAnonymizerPreviewAsync(preset, cancellationToken);

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var consecutiveErrors = 0;
        var recoveryCompleted = false;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (!recoveryCompleted)
                {
                    await _timedMuteActions.RecoverPendingAsync(cancellationToken);
                    try { await _screenActions.RecoverStaleAsync(cancellationToken); }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _collectorStorage.Log("화면 액션 임시 장면 시작 정리 보류 · type=" + ex.GetType().Name);
                    }
                    recoveryCompleted = true;
                }
                await EnsureDeviceRegisteredAsync(cancellationToken);
                if (_wallpaperRequests.Pending)
                    ScheduleDirectWallpaperSync(_wallpaperRequests.Capture(), cancellationToken);
                try
                {
                    await EnsureDeviceSecretRotationAsync(cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _collectorStorage.Log(
                        $"vNext Agent 장치 키 회전 재시도 예약 · type={ex.GetType().Name}");
                }
                try
                {
                    await SyncOverlayAssetsAsync(force: false, cancellationToken: cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException && _overlayAssets.RequiredReady())
                {
                    _collectorStorage.Log(
                        $"오버레이 이미지 원격 확인 보류 · 마지막 로컬본 사용 · type={ex.GetType().Name}");
                }
                if (!_overlayAssets.RequiredReady())
                    throw new InvalidOperationException("필수 오버레이 이미지가 준비될 때까지 Agent 작업 수신을 보류합니다.");
                await ReportDeviceStatusAsync(force: false, cancellationToken);
                await RefreshOverlayBrowserSourceAfterStartupAsync(cancellationToken);
                await FlushOutboxAsync(cancellationToken);

                var claimRequested = Interlocked.Exchange(ref _executionClaimRequested, 0) != 0;
                if (_wakeListener.Connected && !claimRequested)
                {
                    var dueExecution = true;
                    try
                    {
                        dueExecution = await _client.HasPendingAgentExecutionAsync(
                            _deviceId,
                            _deviceSecret,
                            SupportedActionTypes(),
                            cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // The direct probe is only a cost optimization. On any
                        // uncertainty, preserve the old Edge claim recovery so
                        // an action can never be delayed by this change.
                        _collectorStorage.Log(
                            "Agent 안전 점검 직접 조회 보류 · 기존 claim 사용 · type="
                            + ex.GetType().Name);
                    }
                    if (!dueExecution)
                    {
                        Publish(true, InflightExecutionCount() > 0 ? "액션 실행 중" : "대기 중", "");
                        await WaitOrWakeAsync(
                            InflightExecutionCount() > 0
                                ? TimeSpan.FromMilliseconds(500)
                                : RealtimeConnectedRecoveryInterval,
                            cancellationToken);
                        continue;
                    }
                }
                if (!await _executionSlots.WaitAsync(0, cancellationToken))
                {
                    await WaitForExecutionCapacityAsync(cancellationToken);
                    continue;
                }

                var slotTransferred = false;
                try
                {
                var claimEpoch = _client.CaptureSessionEpoch();
                if (!_client.IsSessionEpochCurrent(claimEpoch))
                    throw new VNextDevelopmentException("뉴별록 연결이 변경됐습니다.", 401, "stale_session");
                var claim = await _client.ClaimAgentExecutionWithWallpaperAsync(
                    _deviceId,
                    _deviceSecret,
                    SupportedActionTypes(),
                    knownWallpaperRevision: null,
                    leaseSeconds: LeaseSeconds,
                    cancellationToken: cancellationToken);
                if (!_client.IsSessionEpochCurrent(claimEpoch))
                    continue;
                var job = claim.Job;
                consecutiveErrors = 0;
                if (job is null)
                {
                    Publish(true, InflightExecutionCount() > 0 ? "액션 실행 중" : "대기 중", "");
                    await WaitOrWakeAsync(
                        InflightExecutionCount() > 0
                            ? TimeSpan.FromMilliseconds(500)
                            : _wakeListener.Connected
                                ? RealtimeConnectedRecoveryInterval
                                : RealtimeDisconnectedClaimFallback,
                        cancellationToken);
                    continue;
                }

                    // Drain bursts without inserting a direct safety probe in
                    // front of the next claim. The claim RPC still owns all
                    // ordering, leasing, and action priority decisions.
                    Interlocked.Exchange(ref _executionClaimRequested, 1);
                    StartTrackedExecution(job, claimEpoch, cancellationToken);
                    slotTransferred = true;
                }
                finally
                {
                    if (!slotTransferred) _executionSlots.Release();
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (VNextDevelopmentException ex) when (ex.Code == "device_auth_failed")
            {
                _deviceRegistered = false;
                consecutiveErrors++;
                Publish(false, "장치 인증 재확인", "등록된 Agent 장치 키를 다시 확인합니다.");
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(5), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
            catch (VNextDevelopmentException ex) when (ex.Code == "device_enrollment_failed")
            {
                consecutiveErrors++;
                Publish(
                    false,
                    "장치 등록 실패",
                    "기존 1회용 등록 토큰이 만료됐거나 권한이 없습니다. 뉴별록 owner/admin 계정으로 다시 연결해주세요.");
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(15), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
            catch (VNextDevelopmentException ex) when (ex.Code == "recent_authentication_required")
            {
                consecutiveErrors++;
                Publish(
                    false,
                    "새 PC 등록 로그인 필요",
                    "트레이의 ‘뉴별록 기능 연결’에서 owner/admin 계정으로 다시 로그인해주세요.");
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(15), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
            catch (VNextDevelopmentException ex) when (ex.Code == "device_session_already_used")
            {
                consecutiveErrors++;
                Publish(
                    false,
                    "새 PC 등록 재확인",
                    "이 로그인 세션은 다른 PC 등록에 이미 사용됐습니다. 뉴별록 기능을 다시 연결해주세요.");
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(15), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
            catch (VNextDevelopmentException ex) when (ex.Code == "device_limit_reached")
            {
                consecutiveErrors++;
                Publish(
                    false,
                    "등록 PC 한도 도달",
                    "사용하지 않는 PC를 뉴별록 장치 관리에서 해제한 뒤 다시 연결해주세요.");
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(30), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
            catch (Exception ex)
            {
                consecutiveErrors++;
                var delaySeconds = Math.Min(30, 1 << Math.Min(consecutiveErrors - 1, 5));
                var requestDetail = ex is VNextDevelopmentException requestError
                    ? $" · http={requestError.StatusCode} · code={requestError.Code}"
                    : "";
                _collectorStorage.Log(
                    $"vNext Agent 반복 처리 오류 · type={ex.GetType().Name}{requestDetail}");
                Publish(false, "재연결 대기", SafeMessage(ex));
                try { await WaitOrWakeAsync(TimeSpan.FromSeconds(delaySeconds), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
        }
        await DrainInflightExecutionsAsync();
        Publish(false, "중지됨", "");
    }

    private int InflightExecutionCount()
    {
        lock (_executionGate) return _inflightExecutions.Count;
    }

    private void RequestWallpaperSync()
    {
        var requestGeneration = _wallpaperRequests.Request();
        // 풍벽지는 액션 실행 슬롯과 독립된 전용 조회 경로로 즉시 받는다.
        // 액션 4개가 동시에 실행 중이어도 새 후원 카드 수신을 기다리지 않는다.
        if (_deviceRegistered && !_stop.IsCancellationRequested)
            ScheduleDirectWallpaperSync(requestGeneration, _stop.Token);
    }

    private void ScheduleDirectWallpaperSync(long requestGeneration, CancellationToken cancellationToken)
    {
        if (!_wallpaperFetchGate.Wait(0)) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var sessionEpoch = _client.CaptureSessionEpoch();
                var sync = await _client.GetWallpaperSnapshotAsync(
                    _deviceId,
                    _deviceSecret,
                    _wallpaper.Revision,
                    cancellationToken);
                if (!_client.IsSessionEpochCurrent(sessionEpoch)) return;
                _nextWallpaperSyncAtUtc = DateTimeOffset.UtcNow + WallpaperSyncInterval;
                ScheduleWallpaperSync(sync, requestGeneration, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception ex)
            {
                _collectorStorage.Log("풍벽지 즉시 조회 보류 · type=" + ex.GetType().Name);
                ScheduleWallpaperRetry(cancellationToken);
            }
            finally
            {
                try { _wallpaperFetchGate.Release(); } catch (ObjectDisposedException) { }
                if (_wallpaperRequests.Pending && !cancellationToken.IsCancellationRequested)
                    ScheduleDirectWallpaperSync(_wallpaperRequests.Capture(), cancellationToken);
            }
        }, CancellationToken.None);
    }

    private void ScheduleWallpaperRetry(CancellationToken cancellationToken)
    {
        _wallpaperRequests.Request();
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(WallpaperSyncInterval, cancellationToken);
                if (_deviceRegistered)
                    ScheduleDirectWallpaperSync(_wallpaperRequests.Capture(), cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }, CancellationToken.None);
    }

    private void ScheduleWallpaperSync(
        VNextWallpaperSync? sync,
        long requestGeneration,
        CancellationToken cancellationToken)
    {
        if (sync is null) return;
        if (sync.Unavailable)
        {
            ScheduleWallpaperRetry(cancellationToken);
            return;
        }
        if (!sync.Changed)
        {
            _wallpaperRequests.CompleteThrough(requestGeneration);
            if (_wallpaperRequests.Pending)
                ScheduleDirectWallpaperSync(_wallpaperRequests.Capture(), cancellationToken);
            return;
        }
        if (sync.State is null)
        {
            ScheduleWallpaperRetry(cancellationToken);
            return;
        }
        if (!_wallpaperSyncGate.Wait(0))
        {
            // 이전 이미지 적용 중 받은 더 최신 snapshot은 버리지 않는다.
            _wallpaperRequests.Request();
            return;
        }
        _ = Task.Run(async () =>
        {
            var applied = false;
            try
            {
                _overlay.NotifyWallpaperApplyStarted(sync.Revision);
                if (await _wallpaper.ApplyAsync(sync, cancellationToken))
                {
                    applied = true;
                    _wallpaperRequests.CompleteThrough(requestGeneration);
                    _collectorStorage.Log($"풍벽지 로컬 반영 · revision={sync.Revision}");
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception ex)
            {
                _collectorStorage.Log("풍벽지 로컬 반영 보류 · type=" + ex.GetType().Name);
                ScheduleWallpaperRetry(cancellationToken);
            }
            finally
            {
                try { _wallpaperSyncGate.Release(); } catch (ObjectDisposedException) { }
                // 적용 도중 도착한 후속 세대는 즉시 다시 조회한다. 적용 실패는
                // 위의 5초 bounded retry가 처리해 hot loop를 만들지 않는다.
                if (applied && _wallpaperRequests.Pending)
                    ScheduleDirectWallpaperSync(_wallpaperRequests.Capture(), cancellationToken);
            }
        }, CancellationToken.None);
    }

    private async Task RefreshOverlayBrowserSourceAfterStartupAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _startupOverlayRefreshPending) == 0) return;
        var settings = _collectorStorage.LoadObsSettings();
        if (!settings.Enabled) return;
        try
        {
            var refreshed = await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                settings,
                new[] { _overlay.OverlayUrl, _overlay.WallpaperOverlayUrl },
                cancellationToken);
            if (refreshed < 1) return;
            Interlocked.Exchange(ref _startupOverlayRefreshPending, 0);
            _collectorStorage.Log($"Agent 시작 후 OBS 액션·풍벽지 새로고침 · sources={refreshed}");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // OBS가 아직 시작되지 않았거나 WebSocket 연결 전이면 다음 폴링에서 다시 시도합니다.
        }
    }

    private void StartTrackedExecution(
        VNextAgentJob job,
        long claimEpoch,
        CancellationToken cancellationToken)
    {
        var slotLease = new ExecutionSlotLease(_executionSlots, RequestExecutionClaim);
        var task = ProcessJobSafelyAsync(
            job,
            claimEpoch,
            cancellationToken,
            slotLease.Release);
        lock (_executionGate) _inflightExecutions.Add(task);
        _ = task.ContinueWith(
            completed =>
            {
                _ = completed.Exception;
                lock (_executionGate) _inflightExecutions.Remove(completed);
                slotLease.Release();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private async Task ProcessJobSafelyAsync(
        VNextAgentJob job,
        long claimEpoch,
        CancellationToken cancellationToken,
        Action releaseSlotAfterTimedMuteAccepted)
    {
        try
        {
            await ProcessJobAsync(
                job,
                claimEpoch,
                cancellationToken,
                releaseSlotAfterTimedMuteAccepted);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 종료 과정에서 활성 음소거 세션이 원상 복구된 뒤 끝납니다.
        }
        catch (Exception ex)
        {
            Publish(false, "액션 확인 필요", SafeMessage(ex));
            _collectorStorage.Log(
                $"vNext Agent 작업 처리 오류 · execution={Short(job.ExecutionId)} · type={ex.GetType().Name}");
        }
    }

    private async Task WaitForExecutionCapacityAsync(CancellationToken cancellationToken)
    {
        Task[] snapshot;
        lock (_executionGate) snapshot = _inflightExecutions.ToArray();
        if (snapshot.Length == 0) return;
        var wake = WaitOrWakeAsync(TimeSpan.FromMilliseconds(500), cancellationToken);
        await Task.WhenAny(Task.WhenAny(snapshot), wake);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private async Task DrainInflightExecutionsAsync()
    {
        Task[] snapshot;
        lock (_executionGate) snapshot = _inflightExecutions.ToArray();
        try { await Task.WhenAll(snapshot); }
        catch { /* 각 작업은 자체 오류를 상태/로그로 변환합니다. */ }
    }

    private async Task EnsureDeviceRegisteredAsync(CancellationToken cancellationToken)
    {
        if (_deviceRegistered) return;
        await _registrationGate.WaitAsync(cancellationToken);
        try
        {
            if (_deviceRegistered) return;
            var enrollmentToken = _collectorStorage.LoadVNextAgentEnrollmentToken();
            var registrationEpoch = _client.CaptureSessionEpoch();
            if (!_client.IsSessionEpochCurrent(registrationEpoch))
                throw new VNextDevelopmentException("뉴별록 연결이 변경됐습니다.", 401, "stale_session");
            var registration = await _client.RegisterAgentDeviceAsync(
                _deviceId,
                _deviceSecret,
                enrollmentToken,
                cancellationToken);
            if (!_client.IsSessionEpochCurrent(registrationEpoch))
                throw new VNextDevelopmentException("이전 연결의 장치 등록 결과를 버렸습니다.", 401, "stale_session");
            _deviceRegistered = true;
            if (enrollmentToken is not null)
                _collectorStorage.DeleteVNextAgentEnrollmentToken();

            _collectorStorage.Log(
                $"vNext Agent 장치 인증 완료 · device={Short(registration.DeviceId)} · created={registration.Created}");
            Publish(true, registration.Created ? "장치 등록 완료" : "장치 인증 완료", "");
        }
        finally
        {
            _registrationGate.Release();
        }
    }

    private async Task EnsureDeviceSecretRotationAsync(CancellationToken cancellationToken)
    {
        var rotationDue = _deviceSecretRotatedAt is null
            || _deviceSecretRotatedAt <= DateTimeOffset.UtcNow - DeviceSecretRotationInterval;
        if (!rotationDue && _pendingDeviceSecret is null) return;

        var prepared = _collectorStorage.BeginVNextAgentDeviceSecretRotation(_deviceSecret);
        _pendingDeviceSecret = prepared.PendingDeviceSecret
            ?? throw new InvalidOperationException("Agent 장치 키 회전 준비값이 없습니다.");

        VNextAgentSecretRotationResult? rotated = null;
        try
        {
            rotated = await _client.RotateAgentDeviceSecretAsync(
                _deviceId,
                _deviceSecret,
                _pendingDeviceSecret,
                cancellationToken);
        }
        catch (VNextDevelopmentException ex) when (ex.Code is "device_auth_failed" or "device_enrollment_failed")
        {
            // The server may have committed while its response was lost and the
            // ten-minute old-key overlap may already have ended. Authenticating
            // the persisted pending key proves that it became the current key.
            await _client.RegisterAgentDeviceAsync(
                _deviceId,
                _pendingDeviceSecret,
                enrollmentToken: null,
                cancellationToken);
        }

        var committed = _collectorStorage.CommitVNextAgentDeviceSecretRotation(
            _deviceSecret,
            _pendingDeviceSecret,
            rotated?.SecretRevision ?? Math.Max(2, _deviceSecretRevision + 1),
            rotated?.RotatedAt ?? DateTimeOffset.UtcNow);
        _deviceSecret = committed.DeviceSecret;
        _pendingDeviceSecret = null;
        _deviceSecretRevision = committed.SecretRevision;
        _deviceSecretRotatedAt = committed.RotatedAt;
        _collectorStorage.Log($"vNext Agent 장치 키 회전 완료 · revision={_deviceSecretRevision}");
    }

    private async Task ReportDeviceStatusAsync(bool force, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        if (!force && now < _nextDeviceStatusAt) return;
        var readyRevisions = await _overlayAssets.ReadyRevisionsAsync(cancellationToken);
        var overlayStatus = _overlayAssets.Status();
        var result = await _client.ReportAgentDeviceStatusAsync(
            _deviceId,
            _deviceSecret,
            AgentVersion,
            "windows",
            SupportedActionTypes(),
            overlayStatus.RequiredReady,
            overlayStatus.ManagedCount,
            readyRevisions,
            CollectionHealth(),
            cancellationToken);
        _lastDeviceStatusAt = result.ReportedAt;
        _nextDeviceStatusAt = result.ReportedAt + DeviceStatusInterval;
        _collectorStorage.Log(
            $"vNext Agent 상태 보고 · version={AgentVersion} · imageReady={overlayStatus.RequiredReady} · managed={overlayStatus.ManagedCount} · exactReady={readyRevisions.Count}");
    }

    private VNextCollectionHealth CollectionHealth()
    {
        var session = _collectorStorage.Session;
        if (session?.Active != true)
            return new VNextCollectionHealth("idle", null, null, null);
        var state = _collectorStorage.LastWeflabObservedAt.HasValue ? "active" : "recovering";
        return new VNextCollectionHealth(
            state,
            new DateTimeOffset(session.StartLocal),
            _collectorStorage.LastWeflabObservedAt,
            _collectorStorage.LastSuccessfulUploadAt);
    }

    private async Task<OverlayAssetCacheSyncResult?> SyncOverlayAssetsAsync(
        bool force,
        CancellationToken cancellationToken)
    {
        await _overlayAssetSyncGate.WaitAsync(cancellationToken);
        try
        {
            if (!force && DateTimeOffset.UtcNow < _nextOverlayAssetSyncAt) return null;
            try
            {
                var manifest = await _client.GetOverlayAssetManifestAsync(
                    _deviceId,
                    _deviceSecret,
                    cancellationToken);
                var result = await _overlayAssets.SyncAsync(
                    manifest,
                    (asset, token) => _client.DownloadOverlayAssetAsync(asset, token),
                    cancellationToken);
                _nextOverlayAssetSyncAt = DateTimeOffset.UtcNow + OverlayAssetSyncInterval;
                _collectorStorage.Log(
                    $"오버레이 이미지 확인 · available={result.Available} downloaded={result.Downloaded} reused={result.Reused} requiredUnavailable={result.RequiredUnavailable}");
                return result;
            }
            catch (VNextDevelopmentException ex) when (
                ex.Code == "invalid_operation" && _overlayAssets.RequiredReady())
            {
                // Older G3A runtimes did not expose overlay_manifest. The exact
                // built-in asset is compiled into this Agent and verified by
                // immutable ID/SHA, so it remains safe and usable locally.
                _nextOverlayAssetSyncAt = DateTimeOffset.UtcNow + OverlayAssetSyncInterval;
                _collectorStorage.Log("오버레이 이미지 확인 · 서버 manifest 미지원 · 내장 이미지 사용");
                var builtInCount = _overlayAssets.Status().BuiltInCount;
                return new OverlayAssetCacheSyncResult(
                    Available: builtInCount,
                    Downloaded: 0,
                    Reused: builtInCount,
                    Unavailable: 0,
                    RequiredUnavailable: 0,
                    Pruned: 0);
            }
            catch
            {
                _nextOverlayAssetSyncAt = DateTimeOffset.UtcNow.AddSeconds(15);
                throw;
            }
        }
        finally
        {
            _overlayAssetSyncGate.Release();
        }
    }

    private async Task WaitOrWakeAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        await _wakeSignal.WaitAsync(timeout, cancellationToken);
    }

    private async Task FlushOutboxAsync(CancellationToken cancellationToken)
    {
        await _outboxFlushGate.WaitAsync(cancellationToken);
        try
        {
            foreach (var item in _store.DueOutbox())
            {
                try
                {
                    await _client.AckAgentExecutionAsync(_deviceId, _deviceSecret, item.Ack, cancellationToken);
                    _store.MarkOutboxSent(item.Id);
                }
                catch (VNextDevelopmentException ex) when (ex.StatusCode == 409 && ex.Code == "claim_lost")
                {
                    _store.MarkOutboxStale(item.Id, ex.Message);
                }
                catch (VNextDevelopmentException ex) when (ex.StatusCode == 400)
                {
                    _store.MarkOutboxRejected(item.Id, ex.Message);
                }
                catch (VNextDevelopmentException ex) when (ex.StatusCode is 401 or 403)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _store.RescheduleOutbox(item.Id, item.SendAttempts, SafeMessage(ex));
                    break;
                }
            }
        }
        finally
        {
            _outboxFlushGate.Release();
        }
    }

    private async Task ProcessJobAsync(
        VNextAgentJob job,
        long claimEpoch,
        CancellationToken cancellationToken,
        Action releaseSlotAfterTimedMuteAccepted)
    {
        if (!_client.IsSessionEpochCurrent(claimEpoch)) return;
        Publish(true, "작업 수신", "");
        var receipt = _store.Receive(job);
        if (receipt.State is "succeeded" or "terminal_failed" or "retryable_failed")
        {
            _store.QueueCachedAck(job.ExecutionId, job.AttemptNo);
            await FlushOutboxAsync(cancellationToken);
            Publish(true, "중복 실행 차단", "");
            return;
        }
        if (receipt.State == "uncertain")
        {
            _store.ResolveUncertainAndQueueAck(job.ExecutionId, job.AttemptNo);
            await FlushOutboxAsync(cancellationToken);
            Publish(true, "불확실 작업 차단", "자동 재실행하지 않았습니다.");
            return;
        }
        if (!_client.IsSessionEpochCurrent(claimEpoch)) return;
        if (!_store.MarkExecuting(job.ExecutionId, job.AttemptNo))
            throw new InvalidOperationException($"{receipt.State} 상태에서 이 PC 자동화를 시작할 수 없습니다.");
        _collectorStorage.Log(
            $"vNext Agent 액션 시작 · execution={Short(job.ExecutionId)} · action={job.ActionType} · attempt={job.AttemptNo}");

        var started = _client.TryStartSessionOperation(
            claimEpoch,
            cancellationToken,
            token => ExecuteWithLeaseAsync(job, token, releaseSlotAfterTimedMuteAccepted),
            out CancellationTokenSource? sessionAction,
            out Task<(bool Uncertain, VNextAgentOutcome? Outcome, string Error)>? executionTask);
        if (!started || executionTask is null || sessionAction is null)
        {
            sessionAction?.Dispose();
            _store.MarkUncertain(job.ExecutionId, job.AttemptNo, "세션 변경으로 로컬 액션 시작을 차단했습니다.");
            return;
        }

        Publish(true, "액션 실행 중", "");
        (bool Uncertain, VNextAgentOutcome? Outcome, string Error) execution;
        try
        {
            execution = await executionTask;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _store.MarkUncertain(job.ExecutionId, job.AttemptNo, "세션 변경 중인 로컬 액션 결과를 확인할 수 없습니다.");
            Publish(false, "결과 확인 필요", "세션 변경 중인 로컬 액션 결과를 확인할 수 없습니다.");
            return;
        }
        finally
        {
            sessionAction.Dispose();
        }
        if (execution.Uncertain)
        {
            _store.MarkUncertain(job.ExecutionId, job.AttemptNo, execution.Error);
            Publish(false, "결과 확인 필요", execution.Error);
            return;
        }

        _store.CompleteAndQueueAck(job.ExecutionId, job.AttemptNo, execution.Outcome!);
        await FlushOutboxAsync(cancellationToken);
        _collectorStorage.Log(
            $"vNext Agent 액션 결과 · execution={Short(job.ExecutionId)} · action={job.ActionType} · succeeded={execution.Outcome!.Succeeded} · retryable={execution.Outcome.Retryable}");
        Publish(true, execution.Outcome!.Succeeded ? "실행 완료" : "실행 실패", execution.Outcome.Error ?? "");
    }

    private async Task<(bool Uncertain, VNextAgentOutcome? Outcome, string Error)> ExecuteWithLeaseAsync(
        VNextAgentJob job,
        CancellationToken cancellationToken,
        Action releaseSlotAfterTimedMuteAccepted)
    {
        using var actionStop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var actionTask = ExecuteActionAsync(
            job,
            actionStop.Token,
            releaseSlotAfterTimedMuteAccepted);
        var heartbeatTask = HeartbeatLoopAsync(job, heartbeatStop.Token);
        var effectiveTimeoutMs = EffectiveActionTimeoutMs(job);
        var timeoutTask = Task.Delay(effectiveTimeoutMs, cancellationToken);

        try
        {
            var completed = await Task.WhenAny(actionTask, heartbeatTask, timeoutTask);
            if (completed == actionTask)
            {
                try
                {
                    return (false, await actionTask, "");
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    // 액션 내부에서 예외가 발생하면 외부 부작용의 완료 여부를 단정할 수 없다.
                    // 재실행 대신 uncertain으로 보존해 중복 부작용을 막는다.
                    return (true, null, "로컬 액션 결과를 확인할 수 없습니다: " + SafeMessage(ex));
                }
            }

            if (completed == timeoutTask)
            {
                actionStop.Cancel();
                cancellationToken.ThrowIfCancellationRequested();
                return (true, null, $"로컬 액션이 {effectiveTimeoutMs}ms 안전 제한을 초과했습니다.");
            }

            cancellationToken.ThrowIfCancellationRequested();
            Exception? heartbeatError = null;
            try { await heartbeatTask; }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                heartbeatError = ex;
            }
            var heartbeatMessage = heartbeatError is null
                ? "lease heartbeat가 예상보다 일찍 종료됐습니다."
                : "lease heartbeat 실패: " + SafeMessage(heartbeatError);

            if (RequiresGuaranteedRestore(job))
            {
                // A transient lease failure must not cancel the shared physical
                // mute/overlay session. Let it complete and restore safely, then
                // preserve this execution as uncertain for a later idempotent ACK.
                try { await actionTask; }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    return (true, null, heartbeatMessage + " / 로컬 복구 결과: " + SafeMessage(ex));
                }
                return (true, null, heartbeatMessage);
            }

            actionStop.Cancel();
            return (true, null, heartbeatMessage);
        }
        finally
        {
            heartbeatStop.Cancel();
            try { await heartbeatTask; } catch { }
        }
    }

    private static bool IsTimedMuteAction(VNextAgentJob job) =>
        job.ActionType is TimedMuteActionAdapter.ObsActionType
            or TimedMuteActionAdapter.WindowsActionType
            or TimedMuteActionAdapter.VoiceAnonymizerActionType
            or TimedMuteActionAdapter.VoiceAnonymizerPresetActionType;

    private static bool RequiresGuaranteedRestore(VNextAgentJob job) =>
        IsTimedMuteAction(job)
        || job.ActionType is ScreenActionAdapter.FlipActionType
            or ScreenActionAdapter.ShakeActionType;

    internal static int EffectiveActionTimeoutMs(VNextAgentJob job)
    {
        if (IsTimedMuteAction(job))
            return Math.Max(job.TimeoutMs, TimedMuteContract.MaximumAccumulatedDurationMs + 30_000);
        if (job.ActionType == RaffleOverlayActionAdapter.ActionType)
            return RaffleOverlayActionAdapter.EffectiveTimeoutMs(job.ActionParams, job.TimeoutMs);
        if (job.ActionType == FlashbangOverlayActionAdapter.ActionType)
            return Math.Max(job.TimeoutMs, 180_000);
        if (job.ActionType is ScreenActionAdapter.FlipActionType or ScreenActionAdapter.ShakeActionType)
            return Math.Max(job.TimeoutMs, 75_000);
        if (job.ActionType is VisualEffectOverlayActionAdapter.WaterActionType
            or VisualEffectOverlayActionAdapter.FireworksActionType)
            return Math.Max(job.TimeoutMs, 180_000);
        return job.TimeoutMs;
    }

    private async Task HeartbeatLoopAsync(VNextAgentJob job, CancellationToken cancellationToken)
    {
        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            await _client.HeartbeatAgentExecutionAsync(
                _deviceId,
                _deviceSecret,
                job.ExecutionId,
                job.AttemptNo,
                LeaseSeconds,
                cancellationToken);
        }
    }

    private async Task<VNextAgentOutcome> ExecuteActionAsync(
        VNextAgentJob job,
        CancellationToken cancellationToken,
        Action releaseSlotAfterTimedMuteAccepted)
    {
        var freshness = VNextActionFreshness.ValidateAndStrip(
            job.ActionParams,
            DateTimeOffset.UtcNow,
            out var actionParameters,
            out var notAfterUtc,
            out var freshnessError);
        if (freshness is VNextActionFreshnessStatus.Expired or VNextActionFreshnessStatus.Invalid)
        {
            _collectorStorage.Log(
                $"vNext Local Agent 액션 시작 차단 · execution={Short(job.ExecutionId)} · action={job.ActionType} · reason={freshness}");
            return new VNextAgentOutcome(false, false, null, freshnessError);
        }

        using var displayObservationScope = _overlay.BeginExecution(job.ExecutionId);

        if (job.ActionType == "obs.set_input_mute")
            return await _obsActions.ExecuteSetInputMuteAsync(actionParameters, cancellationToken);

        if (job.ActionType is TimedMuteActionAdapter.ObsActionType or TimedMuteActionAdapter.WindowsActionType)
        {
            return job.ActionType == TimedMuteActionAdapter.ObsActionType
                ? await _timedMuteActions.ExecuteObsAsync(
                    actionParameters,
                    job.OverlayAsset,
                    cancellationToken,
                    releaseSlotAfterTimedMuteAccepted,
                    notAfterUtc)
                : await _timedMuteActions.ExecuteWindowsAsync(
                    actionParameters,
                    job.OverlayAsset,
                    cancellationToken,
                    releaseSlotAfterTimedMuteAccepted,
                    notAfterUtc);
        }

        if (job.ActionType is TimedMuteActionAdapter.VoiceAnonymizerActionType
            or TimedMuteActionAdapter.VoiceAnonymizerPresetActionType)
        {
            return await _timedMuteActions.ExecuteVoiceAnonymizerAsync(
                actionParameters,
                cancellationToken,
                releaseSlotAfterTimedMuteAccepted,
                notAfterUtc);
        }

        if (job.ActionType == RaffleOverlayActionAdapter.ActionType)
            return await _raffleOverlayActions.ExecuteAsync(
                job.ExecutionId,
                job.AttemptNo,
                actionParameters,
                cancellationToken,
                notAfterUtc);

        if (job.ActionType == FlashbangOverlayActionAdapter.ActionType)
            return await _flashbangOverlayActions.ExecuteAsync(
                actionParameters,
                cancellationToken,
                notAfterUtc);

        if (job.ActionType is ScreenActionAdapter.FlipActionType or ScreenActionAdapter.ShakeActionType)
            return await _screenActions.ExecuteAsync(
                job.ActionType,
                actionParameters,
                cancellationToken,
                notAfterUtc);

        if (job.ActionType is VisualEffectOverlayActionAdapter.WaterActionType
            or VisualEffectOverlayActionAdapter.FireworksActionType)
            return await _visualEffectActions.ExecuteAsync(
                job.ActionType,
                actionParameters,
                cancellationToken,
                notAfterUtc);

        if (job.ActionType == "local.log")
        {
            var label = actionParameters.TryGetProperty("label", out var value)
                && value.ValueKind == System.Text.Json.JsonValueKind.String
                ? value.GetString() ?? "LOCAL_ACTION_EXECUTED"
                : "LOCAL_ACTION_EXECUTED";
            _collectorStorage.Log(
                $"vNext Local Agent 액션 · execution={Short(job.ExecutionId)} · attempt={job.AttemptNo} · label={label}");
            return new VNextAgentOutcome(true, false, new { message = label }, null);
        }

        if (job.ActionType == "local.dev_delay")
        {
            if (!actionParameters.TryGetProperty("delayMs", out var delayValue)
                || !delayValue.TryGetInt32(out var delayMs)
                || delayMs < 0
                || delayMs > 300_000)
                return new VNextAgentOutcome(false, false, null, "잘못된 개발 지연 액션입니다.");
            await Task.Delay(delayMs, cancellationToken);
            return new VNextAgentOutcome(true, false, new { message = "LOCAL_DELAY_COMPLETED" }, null);
        }

        return new VNextAgentOutcome(false, false, null, $"지원하지 않는 로컬 액션: {job.ActionType}");
    }

    private static string[] SupportedActionTypes() =>
        VNextAgentCapabilities.ForWindowsAgent();

    private void QueueDisplayObservation(ByeollogOverlayDisplayObservation observation)
    {
        if (_disposed || _stop.IsCancellationRequested || !_deviceRegistered) return;
        if (Interlocked.Increment(ref _pendingDisplayObservations) > 16)
        {
            Interlocked.Decrement(ref _pendingDisplayObservations);
            return;
        }

        _ = Task.Run(async () =>
        {
            var acquired = false;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(8));
                await _displayObservationGate.WaitAsync(timeout.Token);
                acquired = true;
                if (!_deviceRegistered || _stop.IsCancellationRequested) return;
                _ = await _client.ReportDisplayObservationAsync(
                    _deviceId,
                    _deviceSecret,
                    observation,
                    timeout.Token);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                // 계측은 표시·ACK 경로 밖의 best-effort 작업이다. 실패 유형만 남기고
                // 액션이나 풍벽지 처리를 재시도/지연시키지 않는다.
                _collectorStorage.Log("화면 지연 계측 보류 · type=" + ex.GetType().Name);
            }
            finally
            {
                if (acquired)
                {
                    try { _displayObservationGate.Release(); } catch (ObjectDisposedException) { }
                }
                Interlocked.Decrement(ref _pendingDisplayObservations);
            }
        }, CancellationToken.None);
    }

    public async Task<bool> WaitForAckAsync(string executionId, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_store.IsAckSent(executionId)) return true;
            await Task.Delay(200, cancellationToken);
        }
        return _store.IsAckSent(executionId);
    }

    public async Task<VNextAgentAck?> WaitForAckOutcomeAsync(
        string executionId,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var ack = _store.GetRecordedAck(executionId);
            if (ack is not null && VNextAgentStore.IsFinalLocalOutcome(ack)) return ack;
            await Task.Delay(200, cancellationToken);
        }
        var finalAck = _store.GetRecordedAck(executionId);
        return finalAck is not null && VNextAgentStore.IsFinalLocalOutcome(finalAck) ? finalAck : null;
    }

    private void Publish(bool connected, string state, string error)
    {
        var stats = _store.Stats();
        var overlayAssets = _overlayAssets.Status();
        lock (_statusGate)
        {
            _status = new VNextLocalAgentStatus(
                _loop is not null && !_stop.IsCancellationRequested,
                connected,
                state,
                stats.PendingAcks,
                stats.Uncertain,
                overlayAssets.RequiredReady,
                overlayAssets.ManagedCount,
                overlayAssets.ManifestGeneratedAt,
                error);
        }
        try { StatusChanged?.Invoke(this, EventArgs.Empty); } catch { }
    }

    private static string Short(string value) => value.Length <= 12 ? value : value[^12..];
    private static string SafeMessage(Exception error) => error.Message.Length <= 500 ? error.Message : error.Message[..500];

    private void Client_SessionChanged(object? sender, EventArgs e)
    {
        _wakeListener.Reconnect();
        RequestExecutionClaim();
        RequestWallpaperSync();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _client.SessionChanged -= Client_SessionChanged;
        _overlay.DisplayObserved -= QueueDisplayObservation;
        _stop.Cancel();
        _wakeListener.Dispose();
        Wake();

        var loop = _loop;
        var stopped = loop is null;
        if (loop is not null)
        {
            try { stopped = loop.Wait(TimeSpan.FromSeconds(3)); } catch { stopped = true; }
        }

        if (stopped)
        {
            DisposeResources();
        }
        else
        {
            _ = loop!.ContinueWith(completed =>
            {
                _ = completed.Exception;
                DisposeResources();
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
    }

    private void DisposeResources()
    {
        if (Interlocked.Exchange(ref _resourcesDisposed, 1) != 0) return;
        _stop.Dispose();
        _wakeSignal.Dispose();
        _registrationGate.Dispose();
        _overlayAssetSyncGate.Dispose();
        _wallpaperFetchGate.Dispose();
        _wallpaperSyncGate.Dispose();
        _displayObservationGate.Dispose();
        _outboxFlushGate.Dispose();
        _executionSlots.Dispose();
        _overlay.Dispose();
        _wallpaper.Dispose();
        _store.Dispose();
    }
}
