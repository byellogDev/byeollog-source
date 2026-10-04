using System.Reflection;

namespace HurogiCollector;

internal static class UiAssetStore
{
    // A new directory is required whenever an embedded UI changes because
    // WriteResource intentionally preserves an existing versioned cache.
    private const string UiVersion = "v1.0.0.49";

    internal static string Prepare()
    {
        var root = Path.Combine(
            AgentDataPaths.PrepareDataRoot().RootPath,
            "ui",
            UiVersion);

        Directory.CreateDirectory(root);
        WriteResource("HurogiCollector.Ui.wallpaper-appearance.js", Path.Combine(root, "wallpaper-appearance.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-custom-editor.js", Path.Combine(root, "wallpaper-custom-editor.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-custom-editor.css", Path.Combine(root, "wallpaper-custom-editor.css"));
        WriteResource("HurogiCollector.Ui.byeollog_ui.html", Path.Combine(root, "byeollog_ui.html"));
        WriteResource("HurogiCollector.Ui.agent_automation.html", Path.Combine(root, "agent_automation.html"));
        WriteResource("HurogiCollector.Ui.wallpaper-baekdusan.js", Path.Combine(root, "wallpaper-baekdusan.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-detached.js", Path.Combine(root, "wallpaper-detached.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-baekdusan-editor.js", Path.Combine(root, "wallpaper-baekdusan-editor.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-baekdusan-editor.css", Path.Combine(root, "wallpaper-baekdusan-editor.css"));
        WriteResource("HurogiCollector.Ui.wallpaper_editor.html", Path.Combine(root, "wallpaper_editor.html"));
        WriteResource("HurogiCollector.Ui.byeollog_theme.css", Path.Combine(root, "byeollog-theme.css"));
        WriteResource("HurogiCollector.Assets.byeollog_symbol.png", Path.Combine(root, "byeollog_symbol.png"));
        WriteResource("HurogiCollector.Ui.byeollog_logo_dark_safe.png", Path.Combine(root, "byeollog_logo_dark_safe.png"));
        WriteResource("HurogiCollector.Ui.byeollog_logo_light_safe.png", Path.Combine(root, "byeollog_logo_light_safe.png"));
        WriteResource("HurogiCollector.Ui.draw-board-editor.js", Path.Combine(root, "draw-board-editor.js"));
        WriteResource("HurogiCollector.Ui.draw-board.css", Path.Combine(root, "draw-board.css"));
        return root;
    }

    private static void WriteResource(string resourceName, string destination)
    {
        if (File.Exists(destination)) return;
        var assembly = Assembly.GetExecutingAssembly();
        using var input = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"UI 리소스를 찾지 못했습니다: {resourceName}");
        using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.Read);
        input.CopyTo(output);
    }
}
