namespace HurogiCollector;

internal static class CoreProductScope
{
    public static bool LocalActionExecutionEnabled => false;

    public static bool IsAllowedMainUiAction(string action) => action is
        "windowDrag" or
        "supportRequest" or
        "minimize" or
        "close" or
        "exit" or
        "theme" or
        "login" or
        "forgotPassword" or
        "signup" or
        "dashboard" or
        "openAutomationSettings";

    public static bool IsAllowedWallpaperUiAction(string action) => action is
        "automationWindowDrag" or
        "automationMinimize" or
        "automationClose" or
        "theme" or
        "closeAutomation" or
        "copyWallpaperOverlayUrl" or
        "refreshWallpaperOverlay" or
        "automationReady";
}
