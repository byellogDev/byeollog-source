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
        return prepared;
    }
}
