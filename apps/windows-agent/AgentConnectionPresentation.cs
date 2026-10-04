namespace HurogiCollector;

internal static class AgentConnectionPresentation
{
    internal static string RecoveryState(bool signedIn, bool connected, bool running,
        string sessionState, bool startupFailed)
    {
        if (startupFailed) return "failed";
        // A live retry loop is not proof that credentials can recover themselves.
        if (!signedIn && (running || sessionState == "attention")) return "attention";
        if (signedIn && connected) return "ready";
        return signedIn ? "recovering" : sessionState;
    }
}
