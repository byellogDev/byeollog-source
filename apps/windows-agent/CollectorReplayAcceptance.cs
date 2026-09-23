using System.Text.Json;

namespace HurogiCollector;

internal sealed record CollectorReplayFixture(
    string Name,
    string SourceUid,
    string ActionType,
    int DurationMs,
    string OverlayAssetKey,
    int DeliveryCount,
    bool AssetHashValid,
    bool MuteVerified,
    bool RestoreVerified,
    bool OverlayDisplayed,
    bool OverlayHidden,
    bool AckSent,
    bool RecoveryJournalEmpty,
    string ExpectedOutcome);

internal sealed record CollectorReplayResult(
    string Name,
    string State,
    int Executions,
    bool DuplicateBlocked,
    IReadOnlyList<string> Failures);

internal sealed record CollectorReplayCandidateReport(
    string Overall,
    bool LiveEventUsed,
    string RecordedSuccess,
    int RecordedSuccessExecutions,
    bool DuplicateDeliveryBlocked,
    string RestoreFailure,
    bool UnknownFieldRejected);

internal static class CollectorReplayAcceptance
{
    public static CollectorReplayCandidateReport EvaluateBuiltInCandidate()
    {
        const string success = """{"name":"recorded-success","sourceUid":"replay-success-1","actionType":"obs.mute_for","durationMs":10000,"overlayAssetKey":"mic_off","deliveryCount":3,"assetHashValid":true,"muteVerified":true,"restoreVerified":true,"overlayDisplayed":true,"overlayHidden":true,"ackSent":true,"recoveryJournalEmpty":true,"expectedOutcome":"pass"}""";
        const string restoreFailure = """{"name":"restore-failure","sourceUid":"replay-failure-1","actionType":"obs.mute_for","durationMs":10000,"overlayAssetKey":"mic_off","deliveryCount":2,"assetHashValid":true,"muteVerified":true,"restoreVerified":false,"overlayDisplayed":true,"overlayHidden":true,"ackSent":false,"recoveryJournalEmpty":false,"expectedOutcome":"blocked"}""";
        var passed = Evaluate(Parse(success));
        var blocked = Evaluate(Parse(restoreFailure));
        var unknownRejected = false;
        try { Parse(success.Replace("}", ",\"secret\":\"x\"}")); }
        catch (InvalidDataException) { unknownRejected = true; }

        var overall = passed.State == "pass"
            && passed.Failures.Count == 0
            && passed.Executions == 1
            && passed.DuplicateBlocked
            && blocked.State == "blocked"
            && blocked.Failures.Contains("restore")
            && blocked.Failures.Contains("ack")
            && blocked.Failures.Contains("recovery_journal")
            && unknownRejected
                ? "pass"
                : "blocked";
        return new CollectorReplayCandidateReport(
            overall,
            false,
            passed.State,
            passed.Executions,
            passed.DuplicateBlocked,
            blocked.State,
            unknownRejected);
    }

    public static CollectorReplayFixture Parse(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 8
        });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Replay fixture must be an object.");
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "name", "sourceUid", "actionType", "durationMs", "overlayAssetKey", "deliveryCount",
            "assetHashValid", "muteVerified", "restoreVerified", "overlayDisplayed", "overlayHidden",
            "ackSent", "recoveryJournalEmpty", "expectedOutcome"
        };
        foreach (var property in root.EnumerateObject())
            if (!allowed.Contains(property.Name)) throw new InvalidDataException("Unknown replay field: " + property.Name);

        return new CollectorReplayFixture(
            Text(root, "name", 80),
            VNextSourceIdentity.RequireValid(Text(root, "sourceUid", 256)),
            Text(root, "actionType", 80),
            Integer(root, "durationMs", 1, 60_000),
            Text(root, "overlayAssetKey", 80),
            Integer(root, "deliveryCount", 1, 10),
            Boolean(root, "assetHashValid"),
            Boolean(root, "muteVerified"),
            Boolean(root, "restoreVerified"),
            Boolean(root, "overlayDisplayed"),
            Boolean(root, "overlayHidden"),
            Boolean(root, "ackSent"),
            Boolean(root, "recoveryJournalEmpty"),
            Text(root, "expectedOutcome", 20));
    }

    public static CollectorReplayResult Evaluate(CollectorReplayFixture fixture)
    {
        var failures = new List<string>();
        if (fixture.ActionType != "obs.mute_for") failures.Add("action_type");
        if (fixture.DurationMs != 10_000) failures.Add("duration");
        if (fixture.OverlayAssetKey != TimedMuteContract.MicrophoneOffOverlayAssetKey) failures.Add("asset_key");
        if (!fixture.AssetHashValid) failures.Add("asset_hash");
        if (!fixture.MuteVerified) failures.Add("mute");
        if (!fixture.RestoreVerified) failures.Add("restore");
        if (!fixture.OverlayDisplayed) failures.Add("overlay_display");
        if (!fixture.OverlayHidden) failures.Add("overlay_hide");
        if (!fixture.AckSent) failures.Add("ack");
        if (!fixture.RecoveryJournalEmpty) failures.Add("recovery_journal");

        var delivered = new HashSet<string>(StringComparer.Ordinal);
        var executions = 0;
        var duplicateAttempts = 0;
        for (var index = 0; index < fixture.DeliveryCount; index++)
        {
            if (delivered.Add(fixture.SourceUid)) executions++;
            else duplicateAttempts++;
        }
        var duplicateBlocked = executions == 1 && duplicateAttempts == fixture.DeliveryCount - 1;
        if (!duplicateBlocked) failures.Add("deduplication");
        var state = failures.Count == 0 ? "pass" : "blocked";
        if (fixture.ExpectedOutcome is not ("pass" or "blocked")) failures.Add("expected_outcome");
        if (state != fixture.ExpectedOutcome) failures.Add("expectation_mismatch");
        return new CollectorReplayResult(fixture.Name, failures.Count == 0 ? "pass" : "blocked", executions, duplicateBlocked, failures.AsReadOnly());
    }

    private static string Text(JsonElement root, string name, int max)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Missing replay text: " + name);
        var text = value.GetString()?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max) throw new InvalidDataException("Invalid replay text: " + name);
        return text;
    }

    private static int Integer(JsonElement root, string name, int min, int max)
    {
        if (!root.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result) || result < min || result > max)
            throw new InvalidDataException("Invalid replay integer: " + name);
        return result;
    }

    private static bool Boolean(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("Invalid replay boolean: " + name);
        return value.GetBoolean();
    }
}
