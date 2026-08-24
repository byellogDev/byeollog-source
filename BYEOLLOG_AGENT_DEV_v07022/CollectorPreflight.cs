using System.Net.WebSockets;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record CollectorPreflightCheck(
    string Key,
    string Label,
    string State,
    string Message);

internal sealed record CollectorPreflightAgentMetrics(
    bool Running,
    bool Connected,
    bool DeviceRegistered,
    DateTimeOffset? LastDeviceStatusAt,
    int DatabaseSchemaVersion,
    int PendingAcks,
    int Uncertain,
    int Succeeded,
    int ExactAssetsReady,
    DateTimeOffset? ManifestGeneratedAt,
    bool TimedMuteRecoveryPending);

internal sealed record CollectorPreflightObsMetrics(
    string State,
    bool Enabled,
    bool InputConfigured,
    bool PasswordConfigured,
    string ObsVersion,
    string WebSocketVersion);

internal sealed record CollectorPreflightReport(
    int SchemaVersion,
    DateTimeOffset GeneratedAtUtc,
    string CollectorVersion,
    string OverallState,
    IReadOnlyList<CollectorPreflightCheck> Checks,
    CollectorPreflightAgentMetrics? Agent,
    CollectorPreflightObsMetrics Obs)
{
    public string UserSummary()
    {
        var title = OverallState switch
        {
            "pass" => "방송 준비 사전진단 통과",
            "attention" => "방송 전 확인할 항목이 있습니다",
            _ => "방송 준비가 완료되지 않았습니다"
        };
        var lines = new List<string> { title, "" };
        foreach (var check in Checks)
        {
            var marker = check.State switch
            {
                "pass" => "통과",
                "attention" => "확인",
                _ => "차단"
            };
            lines.Add($"[{marker}] {check.Label} · {check.Message}");
        }
        lines.Add("");
        lines.Add("읽기 전용 검사이며 마이크·OBS 상태는 변경하지 않았습니다.");
        return string.Join(Environment.NewLine, lines);
    }
}

internal static partial class CollectorPreflightRunner
{
    private static readonly Regex SafeVersionPattern = SafeVersionRegex();

    public static async Task<CollectorPreflightReport> RunAsync(
        string collectorVersion,
        CollectorStorage storage,
        VNextDevelopmentClient developmentClient,
        VNextLocalAgent? localAgent,
        CancellationToken cancellationToken = default)
    {
        var checks = new List<CollectorPreflightCheck>();
        var signedIn = developmentClient.IsSignedIn;
        checks.Add(Check(
            "vnext_session",
            "vNext DEV 연결",
            signedIn ? "pass" : "blocked",
            signedIn ? "보호된 세션이 연결됨" : "뉴별록 계정을 다시 연결해야 함"));

        var scopeLoaded = false;
        var scope = BroadcastReadinessScope.Empty;
        IReadOnlyList<VNextApprovedAssetReference> approvedAssets = Array.Empty<VNextApprovedAssetReference>();
        try
        {
            if (!signedIn) throw new VNextDevelopmentException("세션 없음", code: "missing_session");
            var requirementsTask = developmentClient.LoadBroadcastReadinessRequirementsAsync(cancellationToken);
            var assetsTask = developmentClient.LoadApprovedAssetReferencesAsync(cancellationToken);
            await Task.WhenAll(requirementsTask, assetsTask);
            var requirements = await requirementsTask;
            approvedAssets = await assetsTask;
            scope = BroadcastReadinessPolicy.FromRequirements(requirements, localAgent?.DeviceId);
            scopeLoaded = true;
            checks.Add(Check(
                "active_rule_scope",
                "활성 규칙 범위",
                scope.HasForeignDeviceRules || scope.HasUnsupportedLocalActions ? "blocked" : "pass",
                scope.HasForeignDeviceRules
                    ? "다른 등록 PC에 지정된 활성 규칙은 이 PC에서 확인할 수 없음"
                    : scope.HasUnsupportedLocalActions
                        ? "이 버전이 지원하지 않는 로컬 액션의 활성 규칙이 있음"
                    : $"최소 필드 규칙 {requirements.Count:N0}개 · 100개 상한 확인"));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            checks.Add(Check(
                "active_rule_scope",
                "활성 규칙 범위",
                "blocked",
                "최소 필드 규칙 범위를 확정할 수 없음"));
        }

        VNextLocalAgentPreflight? agent = null;
        VNextLocalOverlayDiagnostics? overlay = null;
        if (localAgent is not null)
        {
            try
            {
                var agentTask = localAgent.CreatePreflightAsync(cancellationToken);
                var overlayTask = localAgent.CreateOverlayDiagnosticsAsync(cancellationToken);
                await Task.WhenAll(agentTask, overlayTask);
                agent = await agentTask;
                overlay = await overlayTask;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                agent = null;
                overlay = null;
            }
        }

        var localRequired = !scopeLoaded
            || scope.RequiresLocalAgent
            || scope.HasForeignDeviceRules
            || scope.HasUnsupportedLocalActions;
        var runtimeOk = agent is not null && agent.Running && agent.DeviceRegistered;
        var runtimeState = !localRequired
            ? "pass"
            : runtimeOk ? agent!.Connected ? "pass" : "attention" : "blocked";
        var runtimeMessage = !localRequired
            ? "이 PC를 실행 대상으로 한 활성 규칙 없음"
            : runtimeState switch
            {
                "pass" => "등록·연결 상태 정상",
                "attention" => "등록됨 · 현재 재연결 중",
                _ => "실행 또는 장치 등록이 완료되지 않음"
            };
        checks.Add(Check("agent_runtime", "이 PC 자동화", runtimeState, runtimeMessage));

        var databaseOk = agent is not null
            && agent.DatabaseIntegrityOk
            && agent.DatabaseForeignKeysOk
            && agent.DatabaseSchemaVersion >= 3;
        checks.Add(Check(
            "agent_database",
            "Agent SQLite",
            !localRequired || databaseOk ? "pass" : "blocked",
            !localRequired
                ? "활성 로컬 규칙 없음"
                : databaseOk
                    ? $"quick_check·FK 정상 · schema {agent!.DatabaseSchemaVersion}"
                    : "무결성 또는 스키마 확인 필요"));

        var obs = await ProbeObsAsync(storage, cancellationToken);
        checks.Add(Check(
            "obs_websocket",
            "OBS WebSocket",
            !scopeLoaded || scope.RequiresObs
                ? obs.State == "ready" ? "pass" : "blocked"
                : "pass",
            !scopeLoaded || scope.RequiresObs
                ? ObsMessage(obs.State)
                : "활성 OBS 규칙 없음 · 설정은 변경하지 않음"));

        var windows = await ProbeWindowsMicrophoneAsync(storage, scopeLoaded && scope.RequiresWindowsMicrophone, cancellationToken);
        checks.Add(Check(
            "windows_microphone",
            "Windows 마이크",
            !scopeLoaded ? "blocked" : windows.State,
            !scopeLoaded ? "활성 규칙 범위를 확인하지 못함" : windows.Message));

        var overlayRequired = !scopeLoaded || scope.RequiresOverlay;
        var overlayHealth = scopeLoaded && (!overlayRequired || (agent?.OverlayLoopbackRunning == true
            && localAgent is not null
            && await ProbeOverlayHealthAsync(localAgent.OverlayUrl, cancellationToken)));
        checks.Add(Check(
            "overlay_loopback",
            "OBS 오버레이",
            overlayHealth ? "pass" : "blocked",
            !overlayRequired
                ? "활성 오버레이 규칙 없음"
                : overlayHealth ? "127.0.0.1 상태 응답 정상" : "localhost 상태 응답 없음"));

        var exactAssetsReady = scopeLoaded && (!overlayRequired || (overlay is not null
            && BroadcastReadinessPolicy.ExactAssetsReady(
                scope.RequiredOverlayAssetIds,
                approvedAssets,
                overlay.ReadyRevisions)));
        checks.Add(Check(
            "approved_assets",
            "오버레이 이미지",
            exactAssetsReady ? "pass" : "blocked",
            !overlayRequired
                ? "활성 오버레이 규칙 없음"
                : exactAssetsReady
                    ? $"필수 정확 ID·SHA {scope.RequiredOverlayAssetIds.Count:N0}개 일치"
                    : "활성 규칙의 오버레이 이미지 ID·SHA가 이 PC 준비본과 일치하지 않음"));

        var queueState = agent is null
            ? localRequired ? "blocked" : "pass"
            : agent.Uncertain > 0 ? "blocked" : agent.PendingAcks > 0 ? "attention" : "pass";
        var queueMessage = agent is null
            ? localRequired ? "상태를 검사할 수 없음" : "활성 로컬 규칙 없음"
            : agent.Uncertain > 0
                ? $"직접 확인이 필요한 불확실 작업 {agent.Uncertain:N0}건"
                : agent.PendingAcks > 0
                    ? $"자동 재전송할 ACK {agent.PendingAcks:N0}건"
                    : "미전송 ACK·불확실 작업 없음";
        checks.Add(Check("ack_queue", "ACK·복구 큐", queueState, queueMessage));
        checks.Add(Check(
            "timed_mute_recovery",
            "마이크 복구 저널",
            agent is null ? localRequired ? "blocked" : "pass" : agent.TimedMuteRecoveryPending ? "blocked" : "pass",
            agent is null
                ? localRequired ? "상태를 검사할 수 없음" : "활성 로컬 규칙 없음"
                : agent.TimedMuteRecoveryPending
                    ? "완료되지 않은 원상복구 기록이 남아 있음"
                    : "미복구 작업 없음"));

        var overall = checks.Any(item => item.State == "blocked")
            ? "blocked"
            : checks.Any(item => item.State == "attention") ? "attention" : "pass";
        var metrics = agent is null ? null : new CollectorPreflightAgentMetrics(
            agent.Running,
            agent.Connected,
            agent.DeviceRegistered,
            agent.LastDeviceStatusAt,
            agent.DatabaseSchemaVersion,
            agent.PendingAcks,
            agent.Uncertain,
            agent.Succeeded,
            agent.ExactAssetsReady,
            agent.ManifestGeneratedAt,
            agent.TimedMuteRecoveryPending);
        return new CollectorPreflightReport(
            1,
            DateTimeOffset.UtcNow,
            SafeVersion(collectorVersion),
            overall,
            checks.AsReadOnly(),
            metrics,
            obs);
    }

    private sealed record WindowsMicrophoneProbe(string State, string Message);

    private static async Task<WindowsMicrophoneProbe> ProbeWindowsMicrophoneAsync(
        CollectorStorage storage,
        bool required,
        CancellationToken cancellationToken)
    {
        if (!required) return new("pass", "활성 Windows 마이크 규칙 없음 · 상태 변경 없음");
        var settings = storage.LoadWindowsCaptureSettings();
        if (!settings.Enabled || string.IsNullOrWhiteSpace(settings.EndpointId))
            return new("blocked", "Windows 마이크 장치 설정 필요");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            _ = await Task.Run(
                () => CoreAudioCaptureAdapter.GetMute(settings.EndpointId, timeout.Token),
                timeout.Token);
            return new("pass", "선택 장치 읽기 성공 · 상태 변경 없음");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return new("blocked", "선택 장치의 현재 상태를 읽을 수 없음");
        }
    }

    private static CollectorPreflightCheck Check(string key, string label, string state, string message) =>
        new(key, label, state, message);

    private static async Task<bool> ProbeOverlayHealthAsync(
        string overlayUrl,
        CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(overlayUrl, UriKind.Absolute, out var baseUri)
            || baseUri.Scheme != Uri.UriSchemeHttp
            || !string.Equals(baseUri.Host, "127.0.0.1", StringComparison.Ordinal)
            || baseUri.Port != ByeollogOverlayService.DefaultPort)
            return false;
        using var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) };
        using var response = await http.GetAsync(
            new Uri(baseUri, "/overlay/health"),
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode) return false;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.ValueKind == JsonValueKind.Object
            && document.RootElement.TryGetProperty("ok", out var ok)
            && ok.ValueKind == JsonValueKind.True;
    }

    private static async Task<CollectorPreflightObsMetrics> ProbeObsAsync(
        CollectorStorage storage,
        CancellationToken cancellationToken)
    {
        var settings = storage.LoadObsSettings();
        var inputConfigured = !string.IsNullOrWhiteSpace(settings.MicrophoneInputName);
        var passwordConfigured = !string.IsNullOrEmpty(settings.Password);
        if (!settings.Enabled)
            return new("disabled", false, inputConfigured, passwordConfigured, "", "");
        if (!inputConfigured)
            return new("input_not_configured", true, false, passwordConfigured, "", "");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            await using var client = await ObsWebSocketClient.ConnectAsync(settings, timeout.Token);
            var info = await client.GetVersionAsync(timeout.Token);
            if (!info.AvailableRequests.Contains("GetInputMute")
                || !info.AvailableRequests.Contains("SetInputMute"))
                return new("missing_capability", true, true, passwordConfigured,
                    SafeVersion(info.ObsStudioVersion), SafeVersion(info.ObsWebSocketVersion));
            _ = await client.GetInputMuteAsync(settings.MicrophoneInputName, timeout.Token);
            return new("ready", true, true, passwordConfigured,
                SafeVersion(info.ObsStudioVersion), SafeVersion(info.ObsWebSocketVersion));
        }
        catch (ObsAuthenticationException)
        {
            return new("authentication_failed", true, true, passwordConfigured, "", "");
        }
        catch (ObsRequestException)
        {
            return new("input_unavailable", true, true, passwordConfigured, "", "");
        }
        catch (ObsProtocolException)
        {
            return new("protocol_error", true, true, passwordConfigured, "", "");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new("unreachable", true, true, passwordConfigured, "", "");
        }
        catch (WebSocketException)
        {
            return new("unreachable", true, true, passwordConfigured, "", "");
        }
        catch
        {
            return new("probe_failed", true, true, passwordConfigured, "", "");
        }
    }

    private static string ObsMessage(string state) => state switch
    {
        "ready" => "인증·입력 읽기·필수 요청 확인 완료",
        "disabled" => "OBS 연결 사용이 꺼져 있음",
        "input_not_configured" => "마이크 입력을 먼저 설정해야 함",
        "authentication_failed" => "WebSocket 인증 설정 확인 필요",
        "input_unavailable" => "설정한 입력을 OBS에서 찾을 수 없음",
        "missing_capability" => "필수 OBS 요청을 지원하지 않음",
        "protocol_error" => "OBS WebSocket 5.x 협상 확인 필요",
        "unreachable" => "localhost OBS에 연결할 수 없음",
        _ => "읽기 전용 연결 검사 실패"
    };

    private static string SafeVersion(string value)
    {
        value = (value ?? "").Trim();
        return SafeVersionPattern.IsMatch(value) ? value : "unknown";
    }

    [GeneratedRegex("^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeVersionRegex();
}
