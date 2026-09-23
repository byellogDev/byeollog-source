using System.Text.Json;

namespace HurogiCollector;

internal sealed record CollectorAcceptanceCheck(
    string Key,
    string Label,
    string State,
    string Message);

internal sealed record CollectorAcceptancePreflightSnapshot(
    string OverallState,
    int PendingAcks,
    int Uncertain,
    int ExactAssetsReady,
    bool TimedMuteRecoveryPending);

internal sealed record CollectorAcceptanceOverlaySnapshot(
    long Revision,
    bool Active,
    long StateRequests,
    long ActiveStateRequests,
    long AssetRequests);

internal sealed record CollectorAcceptanceObservation(
    string State,
    DateTimeOffset? ReceivedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    int AttemptNo,
    bool AckSent,
    int? DurationMs,
    bool MutedVerified,
    bool RestoredVerified,
    bool OverlayDisplayed,
    string OverlayAssetKey,
    int? OverlayAssetVersion,
    string OverlayContentSha256,
    bool ExactOverlayRevisionMatched,
    long ActiveBrowserPolls,
    long OverlayRevisionDelta,
    bool OverlayInactiveAfterCompletion);

internal sealed record CollectorAcceptanceReport(
    int SchemaVersion,
    DateTimeOffset GeneratedAtUtc,
    string CollectorVersion,
    string OverallState,
    DateTimeOffset StartedAtUtc,
    string VisualConfirmation,
    IReadOnlyList<CollectorAcceptanceCheck> Checks,
    CollectorAcceptancePreflightSnapshot Before,
    CollectorAcceptancePreflightSnapshot After,
    CollectorAcceptanceObservation Observation)
{
    public string UserSummary()
    {
        var title = OverallState switch
        {
            "pass" => "아봉10초 실기기 검증 통과",
            "attention" => "자동 검증은 완료됐으며 화면 확인이 남았습니다",
            _ => "아봉10초 실기기 검증을 통과하지 못했습니다"
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
        lines.Add("검증 기능은 실제 이벤트를 만들거나 OBS·마이크 상태를 직접 변경하지 않습니다.");
        return string.Join(Environment.NewLine, lines);
    }
}

internal static class CollectorAcceptanceEvaluator
{
    private const string ObsTimedMuteActionType = "obs.mute_for";
    public const string ConfirmedBoth = "confirmed_obs_and_freeshot";
    public const string VisualFailed = "visual_failed";
    public const string NotObserved = "not_observed";

    public static CollectorAcceptanceReport Evaluate(
        string collectorVersion,
        DateTimeOffset startedAtUtc,
        CollectorAcceptancePreflightSnapshot before,
        CollectorAcceptancePreflightSnapshot after,
        VNextAgentExecutionEvidence? evidence,
        CollectorAcceptanceOverlaySnapshot overlayBefore,
        CollectorAcceptanceOverlaySnapshot overlayAfter,
        string visualConfirmation)
    {
        var observation = BuildObservation(evidence, overlayBefore, overlayAfter);
        var checks = new List<CollectorAcceptanceCheck>();

        checks.Add(Check(
            "preflight_before",
            "시작 전 사전진단",
            IsClean(before) ? "pass" : "blocked",
            IsClean(before) ? "모든 자동화 준비 항목 정상" : "사전진단 또는 복구 큐 확인 필요"));

        var eventObserved = evidence is not null;
        checks.Add(Check(
            "event_observed",
            "실제 이벤트 수신",
            eventObserved ? "pass" : "blocked",
            eventObserved ? "검증 시작 뒤 첫 OBS 시간제 음소거 작업 관찰" : "제한 시간 안에 대상 이벤트가 수신되지 않음"));

        var executionSucceeded = eventObserved
            && string.Equals(evidence!.ActionType, ObsTimedMuteActionType, StringComparison.Ordinal)
            && string.Equals(evidence.State, "succeeded", StringComparison.Ordinal);
        checks.Add(Check(
            "execution_result",
            "이 PC 자동화 실행",
            executionSucceeded ? "pass" : "blocked",
            executionSucceeded ? "중복 없이 성공 상태로 완료" : "성공 완료 상태를 확인하지 못함"));

        checks.Add(Check(
            "duration",
            "아봉 10초 시간",
            observation.DurationMs == 10_000 ? "pass" : "blocked",
            observation.DurationMs == 10_000 ? "요청·실행 시간이 10000ms로 일치" : "10000ms 실행 증거가 없음"));

        var microphoneOk = observation.MutedVerified && observation.RestoredVerified;
        checks.Add(Check(
            "microphone_restore",
            "마이크 음소거·원상복구",
            microphoneOk ? "pass" : "blocked",
            microphoneOk ? "음소거와 실행 전 상태 복구를 모두 확인" : "음소거 또는 원상복구 확인 실패"));

        var overlayOk = observation.OverlayDisplayed
            && string.Equals(observation.OverlayAssetKey, TimedMuteContract.MicrophoneOffOverlayAssetKey, StringComparison.Ordinal)
            && observation.ExactOverlayRevisionMatched;
        checks.Add(Check(
            "exact_overlay",
            "정확한 오버레이 이미지",
            overlayOk ? "pass" : "blocked",
            overlayOk ? $"mic_off 승인본 v{observation.OverlayAssetVersion} 정확 일치" : "실행 작업과 표시 이미지 버전·해시 일치 실패"));

        checks.Add(Check(
            "browser_poll",
            "OBS/FreeShot 브라우저 소스 응답",
            observation.ActiveBrowserPolls > 0 ? "pass" : "blocked",
            observation.ActiveBrowserPolls > 0
                ? $"이미지 활성 중 localhost 상태 조회 {observation.ActiveBrowserPolls}회"
                : "이미지 활성 중 브라우저 소스 조회가 관찰되지 않음"));

        var hidden = observation.OverlayInactiveAfterCompletion && observation.OverlayRevisionDelta >= 2;
        checks.Add(Check(
            "overlay_hidden",
            "이미지 자동 숨김",
            hidden ? "pass" : "blocked",
            hidden ? "표시·숨김 전환 후 투명 상태 복귀" : "종료 후 이미지 잔류 여부 확인 필요"));

        checks.Add(Check(
            "ack_sent",
            "서버 ACK",
            observation.AckSent ? "pass" : "blocked",
            observation.AckSent ? "복구 확인 뒤 성공 ACK 전송 완료" : "성공 ACK 전송이 완료되지 않음"));

        checks.Add(Check(
            "preflight_after",
            "종료 후 안전 상태",
            IsClean(after) ? "pass" : "blocked",
            IsClean(after) ? "ACK·불확실 작업·복구 저널·정확 이미지 정상" : "종료 후 큐 또는 복구 상태 확인 필요"));

        var visualState = visualConfirmation switch
        {
            ConfirmedBoth => "pass",
            VisualFailed => "blocked",
            NotObserved => "attention",
            _ => "attention"
        };
        var visualMessage = visualConfirmation switch
        {
            ConfirmedBoth => "사용자가 OBS와 FreeShot 양쪽 표시·자동 숨김을 확인",
            VisualFailed => "한쪽 이상에서 표시 또는 자동 숨김 문제가 관찰됨",
            NotObserved => "화면을 보지 못해 사용자 확인이 남음",
            _ => "화면을 보지 못해 사용자 확인이 남음"
        };
        checks.Add(Check("visual_confirmation", "OBS·FreeShot 실제 화면", visualState, visualMessage));

        var overall = checks.Any(item => item.State == "blocked")
            ? "blocked"
            : checks.Any(item => item.State == "attention") ? "attention" : "pass";
        return new CollectorAcceptanceReport(
            1,
            DateTimeOffset.UtcNow,
            SafeVersion(collectorVersion),
            overall,
            startedAtUtc,
            NormalizeVisualConfirmation(visualConfirmation),
            checks.AsReadOnly(),
            before,
            after,
            observation);
    }

    private static CollectorAcceptanceObservation BuildObservation(
        VNextAgentExecutionEvidence? evidence,
        CollectorAcceptanceOverlaySnapshot overlayBefore,
        CollectorAcceptanceOverlaySnapshot overlayAfter)
    {
        var durationMs = ReadInt(evidence?.Result, "durationMs");
        var mutedVerified = ReadBool(evidence?.Result, "mutedVerified");
        var restoredVerified = ReadBool(evidence?.Result, "restoredVerified");
        var overlayDisplayed = ReadBool(evidence?.Result, "overlayDisplayed");
        var assetKey = ReadString(evidence?.Result, "overlayAssetKey");
        var assetId = ReadString(evidence?.Result, "overlayAssetId");
        var assetVersion = ReadInt(evidence?.Result, "overlayAssetVersion");
        var contentSha256 = ReadString(evidence?.Result, "overlayContentSha256");
        var exact = evidence is not null
            && !string.IsNullOrWhiteSpace(evidence.ExpectedOverlayAssetId)
            && evidence.ExpectedOverlayAssetVersion is > 0
            && IsSha256(evidence.ExpectedOverlayContentSha256)
            && string.Equals(assetId, evidence.ExpectedOverlayAssetId, StringComparison.OrdinalIgnoreCase)
            && assetVersion == evidence.ExpectedOverlayAssetVersion
            && string.Equals(contentSha256, evidence.ExpectedOverlayContentSha256, StringComparison.Ordinal);

        return new CollectorAcceptanceObservation(
            evidence?.State ?? "not_observed",
            evidence?.ReceivedAtUtc,
            evidence?.CompletedAtUtc,
            evidence?.AttemptNo ?? 0,
            evidence?.AckSent == true,
            durationMs,
            mutedVerified,
            restoredVerified,
            overlayDisplayed,
            assetKey,
            assetVersion,
            IsSha256(contentSha256) ? contentSha256 : "",
            exact,
            Math.Max(0, overlayAfter.ActiveStateRequests - overlayBefore.ActiveStateRequests),
            Math.Max(0, overlayAfter.Revision - overlayBefore.Revision),
            !overlayAfter.Active);
    }

    private static bool IsClean(CollectorAcceptancePreflightSnapshot value) =>
        string.Equals(value.OverallState, "pass", StringComparison.Ordinal)
        && value.PendingAcks == 0
        && value.Uncertain == 0
        && value.ExactAssetsReady > 0
        && !value.TimedMuteRecoveryPending;

    private static bool ReadBool(JsonElement? result, string name) =>
        result is JsonElement root
        && root.ValueKind == JsonValueKind.Object
        && root.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.True;

    private static int? ReadInt(JsonElement? result, string name) =>
        result is JsonElement root
        && root.ValueKind == JsonValueKind.Object
        && root.TryGetProperty(name, out var value)
        && value.TryGetInt32(out var number)
            ? number
            : null;

    private static string ReadString(JsonElement? result, string name) =>
        result is JsonElement root
        && root.ValueKind == JsonValueKind.Object
        && root.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string NormalizeVisualConfirmation(string value) => value switch
    {
        ConfirmedBoth => ConfirmedBoth,
        VisualFailed => VisualFailed,
        _ => NotObserved
    };

    private static CollectorAcceptanceCheck Check(string key, string label, string state, string message) =>
        new(key, label, state, message);

    private static string SafeVersion(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "unknown";
        var safe = new string(value.Where(character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_').ToArray());
        return safe.Length is > 0 and <= 80 ? safe : "unknown";
    }
}
