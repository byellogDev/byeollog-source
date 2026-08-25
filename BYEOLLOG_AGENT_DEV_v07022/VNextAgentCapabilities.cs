namespace HurogiCollector;

internal static class VNextAgentCapabilities
{
    // Only actions routed end-to-end by the deployed G3A runtime belong here.
    // Local diagnostics must never be included in device_status or claim.
    private static readonly string[] WindowsActionTypes =
    [
        "obs.mute_for",
        "obs.voice_anonymize_for",
        "windows.mic_mute_for",
        "raffle.overlay",
        "flashbang.overlay"
    ];

    public static string[] ForWindowsAgent() => [.. WindowsActionTypes];
}
