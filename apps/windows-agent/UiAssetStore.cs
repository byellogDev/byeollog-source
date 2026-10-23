using System.Reflection;

namespace HurogiCollector;

internal static class UiAssetStore
{
    private static readonly object ResourceWriteLock = new();
    // Embedded assets belong to the exact build. Do not depend on a manually
    // bumped UI version: existing installations otherwise keep stale HTML/JS.
    // MVID is stable across restarts and changes when assembly inputs change.
    private static readonly string UiVersion = "bundle-" +
        typeof(UiAssetStore).Assembly.ManifestModule.ModuleVersionId.ToString("N");

    internal static string Prepare() => Prepare(AgentDataPaths.PrepareDataRoot().RootPath);

    internal static string Prepare(string dataRoot)
    {
        var root = Path.Combine(
            dataRoot,
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
        WriteResource("HurogiCollector.Ui.wallpaper-hidden.js", Path.Combine(root, "wallpaper-hidden.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-hidden-editor.js", Path.Combine(root, "wallpaper-hidden-editor.js"));
        WriteResource("HurogiCollector.Ui.wallpaper-hidden-editor.css", Path.Combine(root, "wallpaper-hidden-editor.css"));
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
        var assembly = Assembly.GetExecutingAssembly();
        using var input = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"UI 리소스를 찾지 못했습니다: {resourceName}");
        using var buffer = new MemoryStream();
        input.CopyTo(buffer);
        var expected = buffer.ToArray();
        lock (ResourceWriteLock)
        {
            if (File.Exists(destination))
            {
                if ((File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("UI 캐시에 연결 파일을 사용할 수 없습니다.");
                if (File.ReadAllBytes(destination).AsSpan().SequenceEqual(expected)) return;
            }
            // Never serve a partially written file. Cache is disposable; user settings
            // and older build directories are never modified here.
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    output.Write(expected);
                    output.Flush(flushToDisk: true);
                }
                File.Move(temporary, destination, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
}
