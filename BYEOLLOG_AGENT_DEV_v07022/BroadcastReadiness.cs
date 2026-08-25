namespace HurogiCollector;

internal sealed record BroadcastReadinessScope(
    bool RequiresLocalAgent,
    bool RequiresObs,
    bool RequiresObsVoiceAnonymizer,
    bool RequiresWindowsMicrophone,
    bool RequiresOverlay,
    bool HasForeignDeviceRules,
    bool HasUnsupportedLocalActions,
    IReadOnlyList<string> RequiredOverlayAssetIds,
    bool RequiresObsVoicePresetPair = false)
{
    public static BroadcastReadinessScope Empty { get; } =
        new(false, false, false, false, false, false, false, Array.Empty<string>());
}

internal static class BroadcastReadinessPolicy
{
    public static readonly IReadOnlyList<string> FixedCheckKeys = new[]
    {
        "vnext_session",
        "active_rule_scope",
        "agent_runtime",
        "agent_database",
        "obs_websocket",
        "obs_voice_anonymizer",
        "windows_microphone",
        "overlay_loopback",
        "approved_assets",
        "ack_queue",
        "timed_mute_recovery"
    };

    public static BroadcastReadinessScope FromRequirements(
        IReadOnlyList<VNextReadinessRequirement> requirements,
        string? currentDeviceId)
    {
        var local = requirements
            .Where(item => string.Equals(item.ExecutionTarget, "local_agent", StringComparison.Ordinal))
            .ToArray();
        var current = local.Where(item =>
            string.IsNullOrWhiteSpace(item.AgentDeviceId)
            || string.IsNullOrWhiteSpace(currentDeviceId)
            || string.Equals(item.AgentDeviceId, currentDeviceId, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var foreign = local.Any(item =>
            !string.IsNullOrWhiteSpace(item.AgentDeviceId)
            && !string.IsNullOrWhiteSpace(currentDeviceId)
            && !string.Equals(item.AgentDeviceId, currentDeviceId, StringComparison.OrdinalIgnoreCase));
        var assets = current
            .Where(item => string.Equals(item.ActionType, TimedMuteActionAdapter.ObsActionType, StringComparison.Ordinal))
            .Select(item => item.OverlayAssetId)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var unsupported = current.Any(item => item.ActionType is not (
            "local.log" or
            "local.dev_delay" or
            "obs.set_input_mute" or
            TimedMuteActionAdapter.ObsActionType or
            TimedMuteActionAdapter.VoiceAnonymizerActionType or
            TimedMuteActionAdapter.VoiceAnonymizerPresetActionType or
            TimedMuteActionAdapter.WindowsActionType));
        return new BroadcastReadinessScope(
            current.Length > 0,
            current.Any(item =>
                string.Equals(item.ActionType, TimedMuteActionAdapter.ObsActionType, StringComparison.Ordinal)
                || string.Equals(item.ActionType, TimedMuteActionAdapter.VoiceAnonymizerActionType, StringComparison.Ordinal)
                || string.Equals(item.ActionType, TimedMuteActionAdapter.VoiceAnonymizerPresetActionType, StringComparison.Ordinal)
                || string.Equals(item.ActionType, "obs.set_input_mute", StringComparison.Ordinal)),
            current.Any(item =>
                string.Equals(item.ActionType, TimedMuteActionAdapter.VoiceAnonymizerActionType, StringComparison.Ordinal)
                || string.Equals(item.ActionType, TimedMuteActionAdapter.VoiceAnonymizerPresetActionType, StringComparison.Ordinal)),
            current.Any(item =>
                string.Equals(item.ActionType, TimedMuteActionAdapter.WindowsActionType, StringComparison.Ordinal)),
            assets.Length > 0,
            foreign,
            unsupported,
            assets,
            current.Any(item =>
                string.Equals(item.ActionType, TimedMuteActionAdapter.VoiceAnonymizerPresetActionType, StringComparison.Ordinal)));
    }

    public static bool ExactAssetsReady(
        IReadOnlyList<string> requiredAssetIds,
        IReadOnlyList<VNextApprovedAssetReference> approved,
        IReadOnlyList<VNextReadyOverlayAsset> localReady)
    {
        if (requiredAssetIds.Count == 0) return true;
        var approvedById = approved.ToDictionary(
            item => item.AssetId,
            item => item.ContentSha256,
            StringComparer.OrdinalIgnoreCase);
        var local = new HashSet<string>(
            localReady.Select(item => item.AssetId.ToLowerInvariant() + ":" + item.ContentSha256),
            StringComparer.Ordinal);
        foreach (var assetId in requiredAssetIds)
        {
            if (!approvedById.TryGetValue(assetId, out var expectedSha)) return false;
            if (!local.Contains(assetId.ToLowerInvariant() + ":" + expectedSha)) return false;
        }
        return true;
    }
}
