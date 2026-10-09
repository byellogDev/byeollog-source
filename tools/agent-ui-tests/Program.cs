using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // Load the real application Form. No startup, login, remote requests or customer data.
        var assembly = Assembly.Load("byeollog");
        var storageType = assembly.GetType("HurogiCollector.CollectorStorage", true)!;
        var clientType = assembly.GetType("HurogiCollector.VNextDevelopmentClient", true)!;
        var formType = assembly.GetType("HurogiCollector.CollectorLoginWebForm", true)!;
        var root = Path.Combine(Path.GetTempPath(), "byeollog-login-tray-test", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var legacyUi = Path.Combine(root, "ui", "v1.0.0.50");
        Directory.CreateDirectory(legacyUi);
        File.WriteAllText(Path.Combine(legacyUi, "wallpaper_editor.html"), "legacy UI");
        var assets = assembly.GetType("HurogiCollector.UiAssetStore", true)!;
        var prepare = assets.GetMethod("Prepare", BindingFlags.Static | BindingFlags.NonPublic, new[] { typeof(string) })!;
        var actualUi = (string)prepare.Invoke(null, new object[] { root })!;
        if (actualUi == legacyUi || !File.ReadAllText(Path.Combine(actualUi, "wallpaper_editor.html")).Contains("wallpaper-hidden-editor.js"))
            throw new InvalidOperationException("Published application reuses stale editor UI");
        if ((string)prepare.Invoke(null, new object[] { root })! != actualUi)
            throw new InvalidOperationException("UI bundle is not stable across restart preparation");
        Console.WriteLine("PASS: actual app assembly extracts current embedded UI with old v1.0.0.50 cache retained.");
        // Constructor uses RootPath only. Avoid CollectorStorage's production data-root constructor.
        var storage = RuntimeHelpers.GetUninitializedObject(storageType);
        storageType.GetField("_root", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(storage, root);
        using var client = (IDisposable)Activator.CreateInstance(clientType, new object[] {root})!;
        var failures = new List<string>();
        for (var pass = 0; pass < 3; pass++)
        {
            using var form = (Form)Activator.CreateInstance(formType, BindingFlags.Instance | BindingFlags.NonPublic,
                null, new object[] {storage, client}, null)!;
            var tray = (NotifyIcon)formType.GetField("_trayIcon", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form)!;
            var menu = (ContextMenuStrip)formType.GetField("_trayMenu", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(form)!;
            try
            {
                if (tray.Visible) failures.Add("Preloaded login Form exposes a second tray icon");
                // Also exercise direct Dispose with a visible icon, as on auto-login handoff/cancellation.
                tray.Visible = true;
                form.Dispose();
                if (tray.Visible) failures.Add("Direct Dispose leaves the login tray icon visible");
                if (!menu.IsDisposed) failures.Add("Direct Dispose leaks tray menu and callbacks");
                form.Dispose();
            }
            finally { tray.Visible = false; tray.Dispose(); menu.Dispose(); }
        }
        if (failures.Count != 0) throw new InvalidOperationException(string.Join("; ", failures.Distinct()));
        Console.WriteLine("PASS: actual login Form preload and direct Dispose, 3 cycles; no leftover tray/menu, repeated Dispose safe.");
    }
}
