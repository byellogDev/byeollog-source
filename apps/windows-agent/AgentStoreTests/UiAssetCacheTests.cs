namespace HurogiCollector;

internal static partial class Program
{
    private static string UiAssetCacheTests(string root)
    {
        var old = Path.Combine(root, "ui", "v1.0.0.50");
        Directory.CreateDirectory(old);
        const string legacy = "<html>old editor without hidden card controls</html>";
        File.WriteAllText(Path.Combine(old, "wallpaper_editor.html"), legacy);
        var settings = Path.Combine(root, "wallpaper-hidden-cards-v1.json");
        File.WriteAllText(settings, "preserve user setting sentinel");
        var prepared = UiAssetStore.Prepare(root);
        True(prepared != old, "new assembly must not reuse a pre-existing old UI bundle");
        var html = File.ReadAllText(Path.Combine(prepared, "wallpaper_editor.html"));
        True(html.Contains("wallpaper-hidden-editor.js"), "prepared installed UI loads hide controls");
        True(html.Contains("ByeollogHiddenEditor"), "prepared installed UI renders hide controls");
        foreach (var file in new[] { "wallpaper-hidden-editor.js", "wallpaper-hidden-editor.css", "wallpaper-hidden.js" })
            True(File.Exists(Path.Combine(prepared, file)), "prepared UI contains " + file);
        Equal(legacy, File.ReadAllText(Path.Combine(old, "wallpaper_editor.html")), "old bundle retained for rollback");
        Equal("preserve user setting sentinel", File.ReadAllText(settings), "user settings untouched");
        Equal(prepared, UiAssetStore.Prepare(root), "same installed build reuses its bundle after restart");
        var main = Path.Combine(prepared, "byeollog_ui.html");
        var correctMain = File.ReadAllBytes(main);
        True(!File.ReadAllText(main).Contains("weflabSettings"), "retired settings button and handler absent");
        True(File.ReadAllText(main).Contains("announcementLink"), "announcement retained");
        True(!WebViewTrustPolicy.TryParseUiMessage("{\"action\":\"weflabSettings\",\"payload\":{}}", out _, out _, out _), "stale gear messages remain blocked");
        var timestamp = File.GetLastWriteTimeUtc(main);
        UiAssetStore.Prepare(root);
        Equal(timestamp, File.GetLastWriteTimeUtc(main), "valid cache is not rewritten");
        var corrupt = correctMain.ToArray();
        corrupt[0] ^= 1;
        File.WriteAllBytes(main, corrupt);
        var css = Path.Combine(prepared, "wallpaper-hidden-editor.css");
        var correctCss = File.ReadAllBytes(css);
        File.WriteAllText(css, "partial write");
        var script = Path.Combine(prepared, "wallpaper-hidden.js");
        var correctScript = File.ReadAllBytes(script);
        File.Delete(script);
        Parallel.For(0, 4, _ => UiAssetStore.Prepare(root));
        True(File.ReadAllBytes(main).SequenceEqual(correctMain), "same-length modified HTML repaired from embedded source");
        True(File.ReadAllBytes(css).SequenceEqual(correctCss), "truncated CSS repaired");
        True(File.ReadAllBytes(script).SequenceEqual(correctScript), "missing JavaScript restored");
        Equal(0, Directory.GetFiles(prepared, "*.tmp").Length, "atomic writes leave no partial cache files");
        Equal(legacy, File.ReadAllText(Path.Combine(old, "wallpaper_editor.html")), "repair preserves old UI for rollback");
        Equal("preserve user setting sentinel", File.ReadAllText(settings), "repair preserves user settings");
        return prepared;
    }
}
