namespace HurogiCollector;

internal static class CollectorAcceptanceRunner
{
    public static CollectorAcceptancePreflightSnapshot Snapshot(CollectorPreflightReport report)
    {
        var agent = report.Agent;
        return new CollectorAcceptancePreflightSnapshot(
            report.OverallState,
            agent?.PendingAcks ?? int.MaxValue,
            agent?.Uncertain ?? int.MaxValue,
            agent?.ExactAssetsReady ?? 0,
            agent?.TimedMuteRecoveryPending ?? true);
    }

    public static CollectorAcceptanceOverlaySnapshot Snapshot(VNextLocalAgent agent)
    {
        var telemetry = agent.OverlayTelemetry();
        return new CollectorAcceptanceOverlaySnapshot(
            telemetry.Revision,
            telemetry.Active,
            telemetry.StateRequests,
            telemetry.ActiveStateRequests,
            telemetry.AssetRequests);
    }

    public static async Task<VNextAgentExecutionEvidence?> WaitForFirstObsTimedMuteAsync(
        VNextLocalAgent agent,
        DateTimeOffset startedAtUtc,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(30))
            throw new ArgumentOutOfRangeException(nameof(timeout));

        var deadline = DateTimeOffset.UtcNow + timeout;
        VNextAgentExecutionEvidence? evidence = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            evidence = agent.FindFirstObsTimedMuteSince(startedAtUtc);
            if (evidence is not null)
            {
                if (evidence.State is "terminal_failed" or "retryable_failed" or "uncertain")
                    return evidence;
                if (evidence.State == "succeeded" && evidence.AckSent)
                    return evidence;
            }
            await Task.Delay(250, cancellationToken);
        }
        return evidence;
    }
}
