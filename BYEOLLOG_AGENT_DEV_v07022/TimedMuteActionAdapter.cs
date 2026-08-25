using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class TimedMuteActionAdapter
{
    internal const string ObsActionType = "obs.mute_for";
    internal const string WindowsActionType = "windows.mic_mute_for";
    internal const string VoiceAnonymizerActionType = "obs.voice_anonymize_for";
    internal const string VoiceAnonymizerPresetActionType = "obs.voice_anonymize_for_v2";
    internal const string ObsTargetAlias = "microphone";
    internal const string WindowsTargetAlias = "selected_capture_device";
    internal const string VoiceAnonymizerTargetType = "obs_source_filter";
    internal const string VoiceAnonymizerFilterKind = "vst_filter";

    private readonly CollectorStorage _storage;
    private readonly TimedMuteRecoveryStore _recoveryStore;
    private readonly TimedMuteCoordinator _coordinator;
    private readonly TimedMuteCoordinator _voicePreviewCoordinator;
    private readonly ByeollogOverlayService? _overlay;
    private readonly SemaphoreSlim _recoveryCheck = new(1, 1);

    public TimedMuteActionAdapter(
        CollectorStorage storage,
        ByeollogOverlayService? overlay = null)
    {
        _storage = storage;
        _overlay = overlay;
        _recoveryStore = new TimedMuteRecoveryStore(storage.RootPath);
        _coordinator = new TimedMuteCoordinator(
            _recoveryStore,
            BroadcastMutationGate.Gate);
        _voicePreviewCoordinator = new TimedMuteCoordinator(
            _recoveryStore,
            BroadcastMutationGate.Gate);
    }

    public bool HasPendingRecovery() => _recoveryStore.Load() is not null;

    public async Task<TimedMuteRecoveryResult> RecoverPendingAsync(CancellationToken cancellationToken)
    {
        await _recoveryCheck.WaitAsync(cancellationToken);
        try
        {
            var result = await _coordinator.RecoverAsync(CreateRecoveryTarget, cancellationToken);
            if (result.HadPendingOperation)
                _storage.Log($"시간제 음소거 시작 복구 완료 · target={result.TargetType} initialMuted={result.InitialMuted}");
            return result;
        }
        finally
        {
            _recoveryCheck.Release();
        }
    }

    public Task<VNextAgentOutcome> ExecuteObsAsync(
        JsonElement parameters,
        VNextOverlayAssetDescriptor? expectedOverlayAsset,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        DateTimeOffset? notAfterUtc = null) =>
        ExecuteWithOptionalOverlayAsync(
            ObsActionType,
            ObsTargetAlias,
            parameters,
            expectedOverlayAsset,
            cancellationToken,
            onAccepted,
            notAfterUtc);

    public Task<VNextAgentOutcome> ExecuteWindowsAsync(
        JsonElement parameters,
        VNextOverlayAssetDescriptor? expectedOverlayAsset,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        DateTimeOffset? notAfterUtc = null) =>
        ExecuteWithOptionalOverlayAsync(
            WindowsActionType,
            WindowsTargetAlias,
            parameters,
            expectedOverlayAsset,
            cancellationToken,
            onAccepted,
            notAfterUtc);

    public async Task<VNextAgentOutcome> ExecuteVoiceAnonymizerAsync(
        JsonElement parameters,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        DateTimeOffset? notAfterUtc = null)
    {
        if (!ObsVoiceAnonymizerContract.TryReadParameters(parameters, out var durationMs, out var preset))
            return Failure(false, "신원보호모드 액션 설정이 올바르지 않습니다.");

        try
        {
            var target = CreateVoiceAnonymizerTarget(requireEnabled: true, preset);
            if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                throw new VNextActionExpiredException();
            _storage.Log($"신원보호모드 실행 시작 · preset={preset} · durationMs={durationMs}");
            var result = await _coordinator.ExecuteAsync(
                target,
                durationMs,
                cancellationToken,
                onAccepted,
                notAfterUtc: notAfterUtc);
            _storage.Log(
                $"신원보호모드 실행 완료 · initialEnabled={result.InitialMuted} · changed={result.Changed} · enabledVerified={result.MutedVerified} · restoredVerified={result.RestoredVerified}");
            return new VNextAgentOutcome(
                true,
                false,
                new
                {
                    target = "microphone_filter",
                    preset,
                    durationMs = result.DurationMs,
                    initialFilterEnabled = result.InitialMuted,
                    changed = result.Changed,
                    filterEnabledVerified = result.MutedVerified,
                    restoredVerified = result.RestoredVerified
                },
                null);
        }
        catch (TimedMuteRestoreFailedException ex)
        {
            LogVoiceAnonymizerFailure(ex);
            throw;
        }
        catch (TimedMuteCanceledAfterRestoreException ex)
        {
            LogVoiceAnonymizerFailure(ex);
            throw;
        }
        catch (VNextActionExpiredException ex)
        {
            return Failure(false, ex.Message);
        }
        catch (TimedMuteOperationException ex)
        {
            LogVoiceAnonymizerFailure(ex.InnerException ?? ex);
            var retryable = !ex.MutationAttempted && IsTransient(ex.InnerException);
            return Failure(retryable, SafeVoiceAnonymizerFailure(ex.InnerException));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            LogVoiceAnonymizerFailure(ex);
            return Failure(IsTransient(ex), SafeVoiceAnonymizerFailure(ex));
        }
    }

    public async Task<TimedMuteRunResult> RunLocalObsTestAsync(
        int durationMs,
        CancellationToken cancellationToken)
    {
        await RecoverPendingAsync(cancellationToken);
        return await _coordinator.ExecuteAsync(CreateObsTarget(requireEnabled: true), durationMs, cancellationToken);
    }

    public async Task<TimedMuteRunResult> RunLocalWindowsTestAsync(
        int durationMs,
        CancellationToken cancellationToken)
    {
        await RecoverPendingAsync(cancellationToken);
        return await _coordinator.ExecuteAsync(CreateWindowsTarget(requireEnabled: true), durationMs, cancellationToken);
    }

    public async Task<TimedMuteRunResult> RunLocalVoiceAnonymizerPreviewAsync(
        string preset,
        CancellationToken cancellationToken)
    {
        if (!ObsVoiceAnonymizerContract.IsSupportedPreset(preset))
            throw new ArgumentException("지원하지 않는 신원보호 음성 프리셋입니다.", nameof(preset));
        await RecoverPendingAsync(cancellationToken);
        return await _voicePreviewCoordinator.ExecuteAsync(
            CreateVoiceAnonymizerTarget(requireEnabled: true, preset),
            5_000,
            cancellationToken);
    }

    public async Task<ObsVoiceAnonymizerStatus> ProbeVoiceAnonymizerAsync(
        string preset,
        CancellationToken cancellationToken)
    {
        if (!ObsVoiceAnonymizerContract.IsSupportedPreset(preset))
            throw new ArgumentException("지원하지 않는 신원보호 음성 프리셋입니다.", nameof(preset));
        var target = CreateVoiceAnonymizerTarget(requireEnabled: true, preset);
        await BroadcastMutationGate.Gate.WaitAsync(cancellationToken);
        try
        {
            var filter = await target.ReadFilterAsync(cancellationToken);
            return new ObsVoiceAnonymizerStatus(
                true,
                preset,
                target.SourceName,
                target.FilterName,
                filter.FilterKind,
                filter.FilterEnabled);
        }
        finally
        {
            BroadcastMutationGate.Gate.Release();
        }
    }

    public async Task<bool> ProbeWindowsMutedAsync(CancellationToken cancellationToken)
    {
        var target = CreateWindowsTarget(requireEnabled: true);
        await BroadcastMutationGate.Gate.WaitAsync(cancellationToken);
        try { return await target.GetMutedAsync(cancellationToken); }
        finally { BroadcastMutationGate.Gate.Release(); }
    }

    private async Task<VNextAgentOutcome> ExecuteAsync(
        string actionType,
        JsonElement parameters,
        string targetAlias,
        CancellationToken cancellationToken)
    {
        if (!TimedMuteContract.TryReadStrictParameters(parameters, targetAlias, out var durationMs))
            return Failure(false, "시간제 음소거 액션 설정이 올바르지 않습니다.");

        return await ExecuteValidatedAsync(
            actionType,
            targetAlias,
            durationMs,
            overlayAsset: null,
            overlayPlacement: null,
            cancellationToken);
    }

    private async Task<VNextAgentOutcome> ExecuteWithOptionalOverlayAsync(
        string actionType,
        string targetAlias,
        JsonElement parameters,
        VNextOverlayAssetDescriptor? expectedOverlayAsset,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        DateTimeOffset? notAfterUtc = null)
    {
        var valid = actionType == ObsActionType
            ? TimedMuteContract.TryReadObsParameters(parameters, out var durationMs, out var overlayAssetKey, out var overlayPlacement)
            : TimedMuteContract.TryReadWindowsParameters(parameters, out durationMs, out overlayAssetKey, out overlayPlacement);
        if (!valid)
            return Failure(false, "시간제 음소거 액션 설정이 올바르지 않습니다.");

        VNextOverlayAssetDescriptor? overlayAsset = null;
        if (overlayAssetKey is not null)
        {
            if (_overlay is null || (!_overlay.IsRunning && !_overlay.TryStart()))
                return Failure(false, "별록 OBS 오버레이 로컬 주소를 시작할 수 없습니다.");
            if (!_overlay.TryResolveAsset(overlayAssetKey, expectedOverlayAsset, out overlayAsset))
                return Failure(false, "오버레이 이미지가 아직 준비되지 않았습니다.");
        }
        else if (expectedOverlayAsset is not null)
        {
            return Failure(false, "오버레이 화면과 음소거 액션 설정이 일치하지 않습니다.");
        }

        if (overlayAsset is not null
            && !await EnsureOverlayBrowserSourceReadyAsync(actionType, cancellationToken))
        {
            return Failure(
                true,
                "OBS의 별록 오버레이가 준비되지 않았습니다. 브라우저 소스를 확인해주세요.");
        }

        return await ExecuteValidatedAsync(
            actionType,
            targetAlias,
            durationMs,
            overlayAsset,
            overlayPlacement,
            cancellationToken,
            onAccepted,
            notAfterUtc);
    }

    private async Task<VNextAgentOutcome> ExecuteValidatedAsync(
        string actionType,
        string targetAlias,
        int durationMs,
        VNextOverlayAssetDescriptor? overlayAsset,
        TimedMuteOverlayPlacement? overlayPlacement,
        CancellationToken cancellationToken,
        Action? onAccepted = null,
        DateTimeOffset? notAfterUtc = null)
    {

        ITimedMuteTarget target;
        try
        {
            ByeollogOverlayDisplayEvidence? overlayEvidence = null;
            target = actionType == ObsActionType
                ? CreateObsTarget(requireEnabled: true)
                : CreateWindowsTarget(requireEnabled: true);
            _storage.Log(
                $"시간제 음소거 실행 시작 · action={actionType} · durationMs={durationMs} · overlay={overlayAsset is not null}");
            // Startup recovery is completed by VNextLocalAgent before it begins
            // claiming work. Re-running recovery here would wait on the active
            // broadcast mutation gate and prevent a second Abong from extending
            // the current timed-mute session while it is still active.
            TimedMuteRunResult result;
            if (overlayAsset is null)
            {
                if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                    throw new VNextActionExpiredException();
                result = await _coordinator.ExecuteAsync(
                    target,
                    durationMs,
                    cancellationToken,
                    onAccepted,
                    notAfterUtc: notAfterUtc);
            }
            else
            {
                var synchronized = await ExecuteMuteAndOverlayAsync(
                    target,
                    durationMs,
                    overlayAsset,
                    overlayPlacement,
                    cancellationToken,
                    onAccepted,
                    notAfterUtc);
                result = synchronized.SideEffectResult;
                overlayEvidence = synchronized.OverlayEvidence;
            }
            var overlayObserved = overlayAsset is null
                || overlayEvidence is { ActiveStateRequestDelta: > 0 };
            // OBS keeps the exact image element alive when the Agent restarts. In that
            // valid case the Browser Source reads the new active state and displays the
            // already loaded revision without requesting the same asset bytes again.
            // Requiring a fresh asset GET therefore misreported a visibly successful
            // dispatch as failed. The active-state GET is the authoritative observation;
            // the image bytes were already allowlisted and hash-verified before SetActive.
            _storage.Log(
                $"시간제 음소거 실행 완료 · action={actionType} · initialMuted={result.InitialMuted} · changed={result.Changed} · mutedVerified={result.MutedVerified} · restoredVerified={result.RestoredVerified} · overlayObserved={overlayObserved} · activeStateDelta={overlayEvidence?.ActiveStateRequestDelta ?? 0}");
            if (!overlayObserved)
            {
                return Failure(
                    false,
                    "마이크 명령은 처리했지만 OBS 브라우저 소스가 오버레이 표시 상태를 읽지 않았습니다.");
            }
            return new VNextAgentOutcome(
                true,
                false,
                new
                {
                    target = targetAlias,
                    durationMs = result.DurationMs,
                    initialMuted = result.InitialMuted,
                    changed = result.Changed,
                    mutedVerified = result.MutedVerified,
                    restoredVerified = result.RestoredVerified,
                    overlayAssetKey = overlayAsset?.AssetKey,
                    overlayAssetId = overlayAsset?.AssetId,
                    overlayAssetVersion = overlayAsset?.VersionNumber,
                    overlayContentSha256 = overlayAsset?.ContentSha256,
                    overlayPositionX = overlayPlacement?.XBasisPoints,
                    overlayPositionY = overlayPlacement?.YBasisPoints,
                    overlayScalePercent = overlayPlacement?.ScalePercent,
                    overlayDisplayed = overlayAsset is not null && overlayObserved,
                    overlayObservedAtUtc = overlayEvidence?.ObservedAtUtc,
                    overlayActiveStateRequestDelta = overlayEvidence?.ActiveStateRequestDelta
                },
                null);
        }
        catch (TimedMuteRestoreFailedException)
        {
            // 복구 저널을 남긴 채 상위 Agent가 uncertain으로 고정해야 합니다.
            throw;
        }
        catch (TimedMuteCanceledAfterRestoreException)
        {
            throw;
        }
        catch (VNextActionExpiredException ex)
        {
            return Failure(false, ex.Message);
        }
        catch (TimedMuteOperationException ex)
        {
            var retryable = !ex.MutationAttempted && IsTransient(ex.InnerException);
            return Failure(retryable, SafeFailureMessage(actionType, ex.InnerException));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Failure(IsTransient(ex), SafeFailureMessage(actionType, ex));
        }
    }

    private async Task<bool> EnsureOverlayBrowserSourceReadyAsync(
        string actionType,
        CancellationToken cancellationToken)
    {
        if (_overlay is null) return false;
        if (await _overlay.WaitForBrowserSourceAsync(
                TimeSpan.FromMilliseconds(600),
                cancellationToken))
            return true;

        var refreshed = 0;
        var settings = _storage.LoadObsSettings();
        if (settings.Enabled)
        {
            try
            {
                refreshed = await ObsActionAdapter.RefreshOverlayBrowserSourcesAsync(
                    settings,
                    _overlay.OverlayUrl,
                    cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _storage.Log(
                    $"OBS 오버레이 자동 새로고침 보류 · action={actionType} · type={ex.GetType().Name}");
            }
        }

        var ready = await _overlay.WaitForBrowserSourceAsync(
            TimeSpan.FromSeconds(3),
            cancellationToken,
            requireNewRequest: true);
        _storage.Log(
            $"OBS 오버레이 연결 확인 · action={actionType} · refreshed={refreshed} · ready={ready}");
        return ready;
    }

    private async Task<ByeollogSynchronizedDisplayResult<TimedMuteRunResult>> ExecuteMuteAndOverlayAsync(
        ITimedMuteTarget target,
        int durationMs,
        VNextOverlayAssetDescriptor overlayAsset,
        TimedMuteOverlayPlacement? overlayPlacement,
        CancellationToken cancellationToken,
        Action? onAccepted,
        DateTimeOffset? notAfterUtc)
    {
        if (_overlay is null)
            throw new InvalidOperationException("별록 OBS 오버레이가 준비되지 않았습니다.");

        return await _overlay.ShowSynchronizedAsync(
            overlayAsset.AssetKey,
            durationMs,
            overlayAsset,
            overlayPlacement,
            (onOverlayObservedAndMuteActive, token) => _coordinator.ExecuteAsync(
                target,
                durationMs,
                token,
                onAccepted,
                onOverlayObservedAndMuteActive,
                notAfterUtc),
            cancellationToken,
            notAfterUtc: notAfterUtc);
    }

    private ITimedMuteTarget CreateRecoveryTarget(TimedMuteRecoveryRecord record) =>
        record.TargetType switch
        {
            "obs_input" => CreateObsTarget(requireEnabled: false, record.TargetKey),
            "windows_capture" => new WindowsCaptureEndpointTarget(record.TargetKey),
            VoiceAnonymizerTargetType => CreateVoiceAnonymizerRecoveryTarget(record.TargetKey),
            _ => throw new InvalidDataException("지원하지 않는 시간제 음소거 복구 대상입니다.")
        };

    private ObsTimedMuteTarget CreateObsTarget(bool requireEnabled, string? inputNameOverride = null)
    {
        var settings = _storage.LoadObsSettings();
        if (requireEnabled && !settings.Enabled)
            throw new InvalidOperationException("별록 에이전트에서 OBS 연결을 먼저 활성화해주세요.");
        var inputName = string.IsNullOrWhiteSpace(inputNameOverride)
            ? settings.MicrophoneInputName
            : inputNameOverride.Trim();
        if (string.IsNullOrWhiteSpace(inputName))
            throw new InvalidOperationException("별록 에이전트의 OBS 마이크 입력을 먼저 설정해주세요.");
        return new ObsTimedMuteTarget(settings with { MicrophoneInputName = inputName });
    }

    private WindowsCaptureEndpointTarget CreateWindowsTarget(bool requireEnabled)
    {
        var settings = _storage.LoadWindowsCaptureSettings();
        if (requireEnabled && !settings.Enabled)
            throw new InvalidOperationException("별록 에이전트에서 Windows 마이크 제어를 먼저 활성화해주세요.");
        if (string.IsNullOrWhiteSpace(settings.EndpointId))
            throw new InvalidOperationException("별록 에이전트의 Windows 캡처 장치를 먼저 선택해주세요.");
        return new WindowsCaptureEndpointTarget(settings.EndpointId);
    }

    private ObsVoiceAnonymizerTarget CreateVoiceAnonymizerTarget(
        bool requireEnabled,
        string preset = ObsVoiceAnonymizerContract.DownPreset)
    {
        var settings = _storage.LoadObsSettings();
        if (requireEnabled && !settings.Enabled)
            throw new InvalidOperationException("별록 에이전트에서 OBS 연결을 먼저 활성화해주세요.");
        if (string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
            throw new InvalidOperationException("별록 에이전트의 OBS 마이크 입력을 먼저 설정해주세요.");
        var filterName = preset switch
        {
            ObsVoiceAnonymizerContract.DownPreset => settings.VoiceAnonymizerFilterName,
            ObsVoiceAnonymizerContract.UpPreset => settings.VoiceAnonymizerUpFilterName,
            _ => throw new InvalidOperationException("지원하지 않는 신원보호 음성 프리셋입니다.")
        };
        if (string.IsNullOrWhiteSpace(filterName))
            throw new InvalidOperationException("OBS 신원보호 VST 2.x 필터 이름을 먼저 설정해주세요.");
        return new ObsVoiceAnonymizerTarget(
            settings,
            settings.MicrophoneInputName,
            filterName);
    }

    private ObsVoiceAnonymizerTarget CreateVoiceAnonymizerRecoveryTarget(string targetKey)
    {
        if (!ObsVoiceAnonymizerContract.TryDecodeTargetKey(targetKey, out var sourceName, out var filterName))
            throw new InvalidDataException("신원보호모드 복구 대상이 올바르지 않습니다.");
        return new ObsVoiceAnonymizerTarget(
            _storage.LoadObsSettings(),
            sourceName,
            filterName);
    }

    private static bool IsTransient(Exception? ex)
    {
        while (ex is TimedMuteOperationException && ex.InnerException is not null)
            ex = ex.InnerException;
        return ex is WebSocketException
            or IOException
            or HttpRequestException
            or COMException;
    }

    private static string SafeFailureMessage(string actionType, Exception? ex) => ex switch
    {
        ObsAuthenticationException => "OBS WebSocket 인증에 실패했습니다. 에이전트 설정을 확인해주세요.",
        ObsProtocolException protocol => $"OBS WebSocket 연결 협상에 실패했습니다. (code {protocol.CloseCode})",
        ObsRequestException request => $"OBS가 시간제 음소거 요청을 거부했습니다. (code {request.Code})",
        WebSocketException or IOException or HttpRequestException =>
            "OBS에 연결할 수 없습니다. OBS 실행 및 WebSocket 설정을 확인해주세요.",
        COMException => "Windows 캡처 장치에 접근할 수 없습니다. 장치 연결과 권한을 확인해주세요.",
        PlatformNotSupportedException => "Windows 마이크 제어는 Windows에서만 사용할 수 있습니다.",
        ArgumentException => actionType == WindowsActionType
            ? "Windows 캡처 장치 설정이 올바르지 않습니다."
            : "OBS 연결 설정이 올바르지 않습니다.",
        InvalidOperationException invalid => invalid.Message,
        InvalidDataException => "음소거 상태 검증 응답이 올바르지 않습니다.",
        _ => "시간제 음소거 실행 중 오류가 발생했습니다."
    };

    private static string SafeVoiceAnonymizerFailure(Exception? ex) => ex switch
    {
        ObsAuthenticationException => "OBS WebSocket 인증에 실패했습니다. 에이전트 설정을 확인해주세요.",
        ObsProtocolException protocol => $"OBS WebSocket 연결 협상에 실패했습니다. (code {protocol.CloseCode})",
        ObsRequestException request => $"OBS가 신원보호 필터 요청을 거부했습니다. (code {request.Code})",
        WebSocketException or IOException or HttpRequestException =>
            "OBS에 연결할 수 없습니다. OBS 실행 및 WebSocket 설정을 확인해주세요.",
        TimedMuteAccumulationLimitException =>
            "연속 신원보호모드 누적 시간이 안전 상한인 15분을 초과합니다.",
        InvalidOperationException =>
            "OBS 연결·마이크·신원보호 VST 2.x 필터 설정을 별록 에이전트에서 확인해주세요.",
        ArgumentException => "OBS 마이크 또는 신원보호 필터 이름이 올바르지 않습니다.",
        InvalidDataException => "OBS 신원보호 필터 상태 응답이 올바르지 않습니다.",
        _ => "신원보호모드 실행 중 오류가 발생했습니다."
    };

    private void LogVoiceAnonymizerFailure(Exception ex)
    {
        var detail = string.Concat((ex.Message ?? "").Select(character =>
            char.IsControl(character) ? ' ' : character));
        if (detail.Length > 300) detail = detail[..300];
        _storage.Log(
            $"신원보호모드 로컬 실행 실패 · type={ex.GetType().Name} · detail={detail}");
    }

    private static VNextAgentOutcome Failure(bool retryable, string error) =>
        new(false, retryable, null, error.Length <= 500 ? error : error[..500]);

    private sealed class ObsTimedMuteTarget : ITimedMuteTarget
    {
        private readonly ObsConnectionSettings _settings;

        public ObsTimedMuteTarget(ObsConnectionSettings settings)
        {
            _settings = settings;
        }

        public string TargetType => "obs_input";
        public string TargetKey => _settings.MicrophoneInputName;

        public async Task<bool> GetMutedAsync(CancellationToken cancellationToken) =>
            (await ObsActionAdapter.ReadMicrophoneStateAsync(_settings, cancellationToken)).InputMuted;

        public async Task SetMutedAsync(bool muted, CancellationToken cancellationToken)
        {
            await ObsActionAdapter.ApplyMicrophoneMuteAsync(_settings, muted, cancellationToken);
        }
    }

    private sealed class ObsVoiceAnonymizerTarget : ITimedMuteTarget
    {
        private readonly ObsConnectionSettings _settings;

        public ObsVoiceAnonymizerTarget(
            ObsConnectionSettings settings,
            string sourceName,
            string filterName)
        {
            if (!ObsVoiceAnonymizerContract.IsValidName(sourceName)
                || !ObsVoiceAnonymizerContract.IsValidName(filterName))
                throw new ArgumentException("OBS 소스 또는 필터 이름이 올바르지 않습니다.");
            _settings = settings;
            SourceName = sourceName;
            FilterName = filterName;
        }

        public string SourceName { get; }
        public string FilterName { get; }
        public string TargetType => VoiceAnonymizerTargetType;
        public string TargetKey => ObsVoiceAnonymizerContract.EncodeTargetKey(SourceName, FilterName);

        public async Task<ObsSourceFilterSummary> ReadFilterAsync(CancellationToken cancellationToken)
        {
            await using var obs = await ObsWebSocketClient.ConnectAsync(_settings, cancellationToken);
            var info = await obs.GetVersionAsync(cancellationToken);
            if (!info.AvailableRequests.Contains("GetSourceFilter")
                || !info.AvailableRequests.Contains("GetSourceFilterList")
                || !info.AvailableRequests.Contains("SetSourceFilterEnabled"))
                throw new InvalidOperationException("연결된 OBS가 필요한 필터 제어 기능을 지원하지 않습니다.");
            var filter = await obs.GetSourceFilterAsync(SourceName, FilterName, cancellationToken);
            if (!string.Equals(filter.FilterKind, VoiceAnonymizerFilterKind, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"OBS의 '{FilterName}' 필터가 VST 2.x 플러그인 필터가 아닙니다.");
            return filter;
        }

        public async Task<bool> GetMutedAsync(CancellationToken cancellationToken) =>
            (await ReadFilterAsync(cancellationToken)).FilterEnabled;

        public async Task SetMutedAsync(bool muted, CancellationToken cancellationToken)
        {
            await using var obs = await ObsWebSocketClient.ConnectAsync(_settings, cancellationToken);
            var info = await obs.GetVersionAsync(cancellationToken);
            if (!info.AvailableRequests.Contains("GetSourceFilter")
                || !info.AvailableRequests.Contains("SetSourceFilterEnabled"))
                throw new InvalidOperationException("연결된 OBS가 필요한 필터 제어 기능을 지원하지 않습니다.");
            var filter = await obs.GetSourceFilterAsync(SourceName, FilterName, cancellationToken);
            if (!string.Equals(filter.FilterKind, VoiceAnonymizerFilterKind, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"OBS의 '{FilterName}' 필터가 VST 2.x 플러그인 필터가 아닙니다.");
            await obs.SetSourceFilterEnabledAsync(SourceName, FilterName, muted, cancellationToken);
        }
    }
}

internal sealed record ObsVoiceAnonymizerStatus(
    bool Ready,
    string Preset,
    string SourceName,
    string FilterName,
    string FilterKind,
    bool FilterEnabled);
