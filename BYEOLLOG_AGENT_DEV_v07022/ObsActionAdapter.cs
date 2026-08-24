using System.Net.WebSockets;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record ObsConnectionProbeResult(
    string ObsStudioVersion,
    string ObsWebSocketVersion,
    bool InputMuted);

internal sealed record ObsMuteApplyResult(
    bool RequestedMuted,
    bool PreviousMuted,
    bool Changed,
    string ObsStudioVersion,
    string ObsWebSocketVersion);

internal sealed record ObsMuteCycleResult(
    string ObsStudioVersion,
    string ObsWebSocketVersion,
    bool InitialMuted,
    bool MutedVerified,
    bool RestoredUnmuted);

internal sealed class ObsMuteCycleRequiresUnmutedException : Exception
{
    public ObsMuteCycleRequiresUnmutedException()
        : base("OBS microphone must start unmuted for this test") { }
}

internal sealed class ObsMuteCycleRestoreFailedException : Exception
{
    public ObsMuteCycleRestoreFailedException()
        : base("OBS microphone restoration could not be verified") { }
}

internal sealed class ObsMuteCycleOperationException : Exception
{
    public ObsMuteCycleOperationException(Exception innerException)
        : base("OBS mute cycle failed after restoration", innerException) { }
}

internal sealed class ObsMuteCycleCanceledAfterRestoreException : OperationCanceledException
{
    public ObsMuteCycleCanceledAfterRestoreException(Exception innerException)
        : base("OBS mute cycle timed out after restoration was verified", innerException) { }
}

/// <summary>
/// 서버에서 받은 논리 별칭을 PC 로컬 OBS 입력명으로 해석합니다.
/// 실제 입력명과 OBS 비밀번호는 서버 작업/ACK/로그로 내보내지 않습니다.
/// </summary>
internal sealed class ObsActionAdapter
{
    private const string MicrophoneTarget = "microphone";
    private readonly CollectorStorage _storage;

    public ObsActionAdapter(CollectorStorage storage)
    {
        _storage = storage;
    }

    public async Task<VNextAgentOutcome> ExecuteSetInputMuteAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        if (!TryReadStrictParams(parameters, out var target, out var muted))
            return Failure(false, "OBS 음소거 액션 설정이 올바르지 않습니다.");
        if (!string.Equals(target, MicrophoneTarget, StringComparison.Ordinal))
            return Failure(false, "지원하지 않는 OBS 입력 별칭입니다.");

        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled)
            return Failure(false, "별록 에이전트에서 OBS 연결을 먼저 활성화해주세요.");
        if (string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
            return Failure(false, "별록 에이전트의 OBS 마이크 입력을 먼저 설정해주세요.");

        var gateHeld = false;
        try
        {
            await BroadcastMutationGate.Gate.WaitAsync(cancellationToken);
            gateHeld = true;
            var applied = await ApplyMicrophoneMuteAsync(settings, muted, cancellationToken);
            return new VNextAgentOutcome(
                true,
                false,
                new
                {
                    target = MicrophoneTarget,
                    requestedMuted = applied.RequestedMuted,
                    previousMuted = applied.PreviousMuted,
                    changed = applied.Changed,
                    obsWebSocketVersion = applied.ObsWebSocketVersion
                },
                null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (ObsAuthenticationException)
        {
            return Failure(false, "OBS WebSocket 인증에 실패했습니다. 에이전트 설정을 확인해주세요.");
        }
        catch (ObsProtocolException ex)
        {
            return Failure(false, $"OBS WebSocket 연결 협상에 실패했습니다. (code {ex.CloseCode})");
        }
        catch (ObsRequestException ex)
        {
            // 207(NotReady)과 702(RequestProcessingFailed)는 잠시 뒤 같은 절대 상태로 재시도할 수 있습니다.
            // 입력 없음(600)과 검증/지원 오류는 설정을 고쳐야 하므로 재시도하지 않습니다.
            var retryable = ex.Code is 207 or 702;
            return Failure(retryable, $"OBS가 음소거 요청을 거부했습니다. (code {ex.Code})");
        }
        catch (ArgumentException)
        {
            return Failure(false, "OBS 연결 설정이 올바르지 않습니다.");
        }
        catch (InvalidDataException)
        {
            return Failure(false, "OBS WebSocket 응답 형식이 올바르지 않습니다.");
        }
        catch (Exception ex) when (ex is WebSocketException or IOException or HttpRequestException)
        {
            // SetInputMute는 절대 상태 지정이라 응답 유실 뒤 같은 값으로 재시도해도 안전합니다.
            return Failure(true, "OBS에 연결할 수 없습니다. OBS 실행 및 WebSocket 설정을 확인해주세요.");
        }
        finally
        {
            if (gateHeld) BroadcastMutationGate.Gate.Release();
        }
    }

    public async Task<ObsConnectionProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        var settings = RequireSettings();
        await BroadcastMutationGate.Gate.WaitAsync(cancellationToken);
        try
        {
            return await ReadMicrophoneStateAsync(settings, cancellationToken);
        }
        finally
        {
            BroadcastMutationGate.Gate.Release();
        }
    }

    /// <summary>
    /// DEV 진단 전용입니다. 마이크가 음소거 해제 상태일 때만 약 1초간
    /// unmuted -> muted -> unmuted 절대 상태 지정을 검증합니다.
    /// 서버 작업을 만들지 않으며, 실패·취소 뒤에도 독립 연결로 unmuted 복구를 시도합니다.
    /// </summary>
    public async Task<ObsMuteCycleResult> RunLocalMuteCycleAsync(CancellationToken cancellationToken)
    {
        var settings = RequireSettings();
        await BroadcastMutationGate.Gate.WaitAsync(cancellationToken);
        try
        {
            var initial = await ReadMicrophoneStateAsync(settings, cancellationToken);
            if (initial.InputMuted)
                throw new ObsMuteCycleRequiresUnmutedException();

            ObsMuteApplyResult? mute = null;
            ObsMuteApplyResult? restore = null;
            ObsConnectionProbeResult? mutedCheck = null;
            ObsConnectionProbeResult? restoredCheck = null;
            Exception? operationError = null;
            var mutationMayHaveOccurred = false;

            try
            {
                // 연결·인증·현재 상태 조회 단계에서는 아직 우리가 상태를 바꾸지 않았습니다.
                // 실제 SetInputMute 전송 직전에만 표시해, 전송 전 실패 뒤 임의로 unmute하지 않습니다.
                // 전송 응답이 유실돼도 변경은 적용됐을 수 있으므로 callback은 await 직전에 실행합니다.
                mute = await ApplyMicrophoneMuteAsync(
                    settings,
                    true,
                    cancellationToken,
                    () => mutationMayHaveOccurred = true);
                if (mute.PreviousMuted && !mute.Changed)
                {
                    // 초기 확인 직후 사용자가 직접 음소거했다면 우리가 변경한 상태가 아니므로 자동 해제하지 않습니다.
                    mutationMayHaveOccurred = false;
                    throw new ObsMuteCycleRequiresUnmutedException();
                }
                if (mute.PreviousMuted || !mute.RequestedMuted || !mute.Changed)
                    throw new InvalidDataException("OBS 실제 음소거 변경 결과가 예상과 다릅니다.");
                mutedCheck = await ReadMicrophoneStateAsync(settings, cancellationToken);
                if (!mutedCheck.InputMuted)
                    throw new InvalidDataException("OBS 실제 음소거 상태가 적용되지 않았습니다.");

                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);

                restore = await ApplyMicrophoneMuteAsync(settings, false, cancellationToken);
                if (!restore.PreviousMuted || restore.RequestedMuted || !restore.Changed)
                    throw new InvalidDataException("OBS 음소거 복구 결과가 예상과 다릅니다.");
                restoredCheck = await ReadMicrophoneStateAsync(settings, cancellationToken);
                if (restoredCheck.InputMuted)
                    throw new InvalidDataException("OBS 음소거 해제 상태가 복구되지 않았습니다.");
            }
            catch (Exception ex)
            {
                operationError = ex;
            }

            // 원래 취소 토큰과 무관하게 새 연결로 최종 unmuted 상태를 최대 3회 확인합니다.
            var restored = !mutationMayHaveOccurred || await TryEnsureUnmutedAsync(settings);
            if (!restored)
                throw new ObsMuteCycleRestoreFailedException();

            if (operationError is OperationCanceledException)
            {
                if (mutationMayHaveOccurred)
                    throw new ObsMuteCycleCanceledAfterRestoreException(operationError);
                throw new OperationCanceledException(
                    "OBS 실제 변경 전 테스트가 취소됐습니다.",
                    operationError,
                    cancellationToken);
            }
            if (operationError is ObsMuteCycleRequiresUnmutedException)
                throw operationError;
            if (operationError is not null)
                throw new ObsMuteCycleOperationException(operationError);

            return new ObsMuteCycleResult(
                initial.ObsStudioVersion,
                initial.ObsWebSocketVersion,
                InitialMuted: initial.InputMuted,
                MutedVerified: mutedCheck is { InputMuted: true },
                RestoredUnmuted: restoredCheck is { InputMuted: false });
        }
        finally
        {
            BroadcastMutationGate.Gate.Release();
        }
    }

    internal static async Task<ObsMuteApplyResult> ApplyMicrophoneMuteAsync(
        ObsConnectionSettings settings,
        bool muted,
        CancellationToken cancellationToken,
        Action? beforeSet = null)
    {
        await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
        var info = await obs.GetVersionAsync(cancellationToken);
        EnsureMuteRequestsAvailable(info);
        var previous = await obs.GetInputMuteAsync(settings.MicrophoneInputName, cancellationToken);
        var changed = previous != muted;
        if (changed)
        {
            beforeSet?.Invoke();
            await obs.SetInputMuteAsync(settings.MicrophoneInputName, muted, cancellationToken);
        }
        return new ObsMuteApplyResult(
            muted,
            previous,
            changed,
            info.ObsStudioVersion,
            info.ObsWebSocketVersion);
    }

    internal static async Task<ObsConnectionProbeResult> ReadMicrophoneStateAsync(
        ObsConnectionSettings settings,
        CancellationToken cancellationToken)
    {
        await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
        var info = await obs.GetVersionAsync(cancellationToken);
        EnsureMuteRequestsAvailable(info);
        var muted = await obs.GetInputMuteAsync(settings.MicrophoneInputName, cancellationToken);
        return new ObsConnectionProbeResult(info.ObsStudioVersion, info.ObsWebSocketVersion, muted);
    }

    internal static async Task<int> RefreshOverlayBrowserSourcesAsync(
        ObsConnectionSettings settings,
        string overlayUrl,
        CancellationToken cancellationToken)
    {
        await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
        var info = await obs.GetVersionAsync(cancellationToken);
        if (!info.AvailableRequests.Contains("GetInputList")
            || !info.AvailableRequests.Contains("GetInputSettings")
            || !info.AvailableRequests.Contains("PressInputPropertiesButton"))
            return 0;

        var refreshed = 0;
        foreach (var input in await obs.GetInputListAsync(cancellationToken))
        {
            var browserKind = string.Equals(
                    input.UnversionedInputKind,
                    "browser_source",
                    StringComparison.OrdinalIgnoreCase)
                || input.InputKind.StartsWith("browser_source", StringComparison.OrdinalIgnoreCase);
            if (!browserKind) continue;

            var inputSettings = await obs.GetInputSettingsAsync(input.InputName, cancellationToken);
            var sourceUrl = inputSettings.TryGetProperty("url", out var urlValue)
                && urlValue.ValueKind == JsonValueKind.String
                ? urlValue.GetString() ?? ""
                : "";
            if (!ByeollogOverlayService.IsMatchingLoopbackOverlayUrl(sourceUrl, overlayUrl)) continue;

            await obs.PressInputPropertiesButtonAsync(
                input.InputName,
                "refreshnocache",
                cancellationToken);
            refreshed++;
        }
        return refreshed;
    }

    internal static async Task<int> EnsureOverlayBrowserAudioRoutingAsync(
        ObsConnectionSettings settings,
        string overlayUrl,
        CancellationToken cancellationToken)
    {
        await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
        var info = await obs.GetVersionAsync(cancellationToken);
        if (!info.AvailableRequests.Contains("GetInputList")
            || !info.AvailableRequests.Contains("GetInputSettings")
            || !info.AvailableRequests.Contains("SetInputSettings"))
            return 0;

        var verified = 0;
        foreach (var input in await obs.GetInputListAsync(cancellationToken))
        {
            var browserKind = string.Equals(
                    input.UnversionedInputKind,
                    "browser_source",
                    StringComparison.OrdinalIgnoreCase)
                || input.InputKind.StartsWith("browser_source", StringComparison.OrdinalIgnoreCase);
            if (!browserKind) continue;

            var inputSettings = await obs.GetInputSettingsAsync(input.InputName, cancellationToken);
            var sourceUrl = inputSettings.TryGetProperty("url", out var urlValue)
                && urlValue.ValueKind == JsonValueKind.String
                ? urlValue.GetString() ?? ""
                : "";
            if (!ByeollogOverlayService.IsMatchingLoopbackOverlayUrl(sourceUrl, overlayUrl)) continue;

            var routed = inputSettings.TryGetProperty("reroute_audio", out var routedValue)
                && routedValue.ValueKind is JsonValueKind.True;
            if (!routed)
            {
                await obs.SetInputSettingsOverlayAsync(
                    input.InputName,
                    new { reroute_audio = true },
                    cancellationToken);
                inputSettings = await obs.GetInputSettingsAsync(input.InputName, cancellationToken);
                routed = inputSettings.TryGetProperty("reroute_audio", out routedValue)
                    && routedValue.ValueKind is JsonValueKind.True;
            }
            if (routed) verified++;
        }
        return verified;
    }

    private static async Task<bool> TryEnsureUnmutedAsync(ObsConnectionSettings settings)
    {
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                await using var obs = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
                var current = await obs.GetInputMuteAsync(settings.MicrophoneInputName, timeout.Token);
                if (current)
                    await obs.SetInputMuteAsync(settings.MicrophoneInputName, false, timeout.Token);
                if (!await obs.GetInputMuteAsync(settings.MicrophoneInputName, timeout.Token))
                    return true;
            }
            catch
            {
                // 다음 독립 연결로 다시 확인합니다. 비밀번호·입력명은 로그에 남기지 않습니다.
            }

            if (attempt < 3) await Task.Delay(250);
        }
        return false;
    }

    private ObsConnectionSettings RequireSettings()
    {
        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled) throw new InvalidOperationException("OBS 연결이 비활성화되어 있습니다.");
        if (string.IsNullOrWhiteSpace(settings.MicrophoneInputName))
            throw new InvalidOperationException("OBS 마이크 입력 이름을 설정해주세요.");
        return settings;
    }

    private static void EnsureMuteRequestsAvailable(ObsServerInfo info)
    {
        if (!info.AvailableRequests.Contains("GetInputMute")
            || !info.AvailableRequests.Contains("SetInputMute"))
            throw new InvalidOperationException("연결된 OBS가 필요한 음소거 요청을 지원하지 않습니다.");
    }

    private static bool TryReadStrictParams(JsonElement value, out string target, out bool muted)
    {
        target = "";
        muted = false;
        if (value.ValueKind != JsonValueKind.Object) return false;
        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (property.Name is not ("target" or "muted")) return false;
        }
        if (count != 2) return false;
        if (!value.TryGetProperty("target", out var targetValue)
            || targetValue.ValueKind != JsonValueKind.String)
            return false;
        target = targetValue.GetString() ?? "";
        if (target.Length is < 1 or > 64) return false;
        if (!value.TryGetProperty("muted", out var mutedValue)
            || mutedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return false;
        muted = mutedValue.GetBoolean();
        return true;
    }

    private static VNextAgentOutcome Failure(bool retryable, string error) =>
        new(false, retryable, null, error);
}
