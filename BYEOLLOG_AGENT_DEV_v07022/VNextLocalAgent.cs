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
    private static readonly TimeSpan DeviceStatusInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DeviceSecretRotationInterval = TimeSpan.FromDays(90);
    private readonly VNextDevelopmentClient _client;
    private readonly CollectorStorage _collectorStorage;
    private readonly VNextAgentStore _store;
    private readonly ObsActionAdapter _obsActions;
    private readonly OverlayAssetCache _overlayAssets;
    private readonly ByeollogOverlayService _overlay;
    private readonly TimedMuteActionAdapter _timedMuteActions;
    private readonly RaffleOverlayActionAdapter _raffleOverlayActions;
    private readonly FlashbangOverlayActionAdapter _flashbangOverlayActions;
    private readonly RaffleWinnerSpeechCache _raffleWinnerSpeechCache;
    private readonly string _deviceId;
    private string _deviceSecret;
    private string? _pendingDeviceSecret;
    private long _deviceSecretRevision;
    private DateTimeOffset? _deviceSecretRotatedAt;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _wakeSignal = new(0, 1);
    private readonly SemaphoreSlim _registrationGate = new(1, 1);
    private readonly SemaphoreSlim _overlayAssetSyncGate = new(1, 1);
    private readonly SemaphoreSlim _outboxFlushGate = new(1, 1);
    private readonly SemaphoreSlim _executionSlots = new(MaximumConcurrentExecutions, MaximumConcurrentExecutions);
    private readonly SemaphoreSlim _raffleSpeechPrewarmGate = new(1, 1);
    private readonly object _executionGate = new();
    private readonly HashSet<Task> _inflightExecutions = [];
    private readonly object _statusGate = new();
    private Task? _loop;
    private VNextLocalAgentStatus _status = new(false, false, "중지됨", 0, 0, true, 0, null, "");
    private bool _disposed;
    private bool _deviceRegistered;
    private DateTimeOffset? _lastDeviceStatusAt;
    private DateTimeOffset _nextOverlayAssetSyncAt = DateTimeOffset.MinValue;
    private DateTimeOffset _nextDeviceStatusAt = DateTimeOffset.MinValue;
    private int _resourcesDisposed;

    public VNextLocalAgent(VNextDevelopmentClient client, CollectorStorage collectorStorage)
    {
        _client = client;
        _collectorStorage = collectorStorage;
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
            _overlay = new ByeollogOverlayService(collectorStorage, _overlayAssets);
            _overlay.TryStart();
            _timedMuteActions = new TimedMuteActionAdapter(collectorStorage, _overlay);
            _raffleWinnerSpeechCache = new RaffleWinnerSpeechCache(
                Path.Combine(collectorStorage.RootPath, "raffle-winner-speech-cache-v1"),
                collectorStorage.Log);
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
                (_, _) => Task.FromResult(new RafflePreparedAudio(
                    ByeollogRaffleAudio.TicketAudioForPreflight(),
                    ByeollogRaffleAudio.TicketSha256,
                    RaffleOverlayActionAdapter.TicketAudioBindingKey)),
                async (executionId, attemptNo, winnerOrdinal, expectedVoiceKey, volumePercent, token) =>
                {
                    byte[] audio;
                    string audioSha256;
                    if (_raffleWinnerSpeechCache.TryRead(expectedVoiceKey, out var cached)
                        && cached is not null)
                    {
                        audio = cached.Audio;
                        audioSha256 = cached.AudioSha256;
                        collectorStorage.Log(
                            "당첨 음성 캐시 사용 · key=" + expectedVoiceKey[..12]
                            + " · version=" + cached.VoiceVersion);
                    }
                    else
                    {
                        var download = await _client.DownloadRaffleWinnerSpeechAsync(
                            _deviceId,
                            _deviceSecret,
                            executionId,
                            attemptNo,
                            winnerOrdinal,
                            expectedVoiceKey,
                            token);
                        await _raffleWinnerSpeechCache.StoreAsync(
                            expectedVoiceKey,
                            download,
                            token);
                        audio = download.Audio;
                        audioSha256 = download.AudioSha256;
                    }
                    return new RafflePreparedAudio(
                        audio,
                        audioSha256,
                        expectedVoiceKey);
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
        }
        catch
        {
            _store.Dispose();
            throw;
        }
        _client.SessionChanged += Client_SessionChanged;
        Publish(false, "시작 대기", "");
    }

    public event EventHandler? StatusChanged;

    public string DeviceId => _deviceId;
    public string OverlayUrl => _overlay.OverlayUrl;

    internal Task<RafflePresentationExecutionEvidence> PreviewRaffleAudioInObsAsync(
        string kind,
        int volumePercent,
        TimedMuteOverlayPlacement placement,
        CancellationToken cancellationToken) =>
        _raffleOverlayActions.PreviewBrowserAudioAsync(
            kind,
            volumePercent,
            placement,
            cancellationToken);

    internal Task<VNextAgentOutcome> PreviewFlashbangInObsAsync(
        string intensity,
        int volumePercent,
        CancellationToken cancellationToken) =>
        _flashbangOverlayActions.PreviewAsync(
            intensity,
            volumePercent,
            cancellationToken);
    public bool OverlayAvailable => _overlay.IsRunning;
    public OverlayAssetCacheStatus OverlayAssetStatus => _overlayAssets.Status();
    public IReadOnlyList<VNextOverlayAssetDescriptor> PackagedOverlayImages() =>
        _overlayAssets.PackagedImageDescriptors();

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

    public VNextLocalAgentStatus Status
    {
        get { lock (_statusGate) return _status; }
    }

    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_loop is not null) return;
        _loop = Task.Run(() => RunAsync(_stop.Token));
        Publish(false, "연결 중", "");
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
                    recoveryCompleted = true;
                }
                await EnsureDeviceRegisteredAsync(cancellationToken);
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
                await FlushOutboxAsync(cancellationToken);
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
                var job = await _client.ClaimAgentExecutionAsync(
                    _deviceId,
                    _deviceSecret,
                    SupportedActionTypes(),
                    LeaseSeconds,
                    cancellationToken);
                if (!_client.IsSessionEpochCurrent(claimEpoch))
                    continue;
                consecutiveErrors = 0;
                if (job is null)
                {
                    Publish(true, InflightExecutionCount() > 0 ? "액션 실행 중" : "대기 중", "");
                    await WaitOrWakeAsync(
                        InflightExecutionCount() > 0 ? TimeSpan.FromMilliseconds(500) : TimeSpan.FromSeconds(2),
                        cancellationToken);
                    continue;
                }

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

    private void StartTrackedExecution(
        VNextAgentJob job,
        long claimEpoch,
        CancellationToken cancellationToken)
    {
        var slotLease = new ExecutionSlotLease(_executionSlots, Wake);
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
                _nextOverlayAssetSyncAt = DateTimeOffset.UtcNow.AddMinutes(1);
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
                _nextOverlayAssetSyncAt = DateTimeOffset.UtcNow.AddMinutes(1);
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

            if (IsTimedMuteAction(job))
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
        job.ActionType is TimedMuteActionAdapter.ObsActionType or TimedMuteActionAdapter.WindowsActionType;

    internal static int EffectiveActionTimeoutMs(VNextAgentJob job)
    {
        if (IsTimedMuteAction(job))
            return Math.Max(job.TimeoutMs, TimedMuteContract.MaximumAccumulatedDurationMs + 30_000);
        if (job.ActionType == RaffleOverlayActionAdapter.ActionType)
            return RaffleOverlayActionAdapter.EffectiveTimeoutMs(job.ActionParams, job.TimeoutMs);
        if (job.ActionType == FlashbangOverlayActionAdapter.ActionType)
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
        Wake();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _client.SessionChanged -= Client_SessionChanged;
        _stop.Cancel();
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
        _outboxFlushGate.Dispose();
        _executionSlots.Dispose();
        _overlay.Dispose();
        _store.Dispose();
    }
}
