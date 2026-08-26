using System.Reflection;

namespace HurogiCollector;

internal static class UiAssetStore
{
    // A new directory is required whenever an embedded UI changes because
    // WriteResource intentionally preserves an existing versioned cache.
    private const string UiVersion = "v0.7.0.97";

    internal static string Prepare()
    {
        var root = Path.Combine(
            AgentDataPaths.PrepareDataRoot().RootPath,
            "ui",
            UiVersion);

        Directory.CreateDirectory(root);
        WriteResource("HurogiCollector.Ui.byeollog_ui.html", Path.Combine(root, "byeollog_ui.html"));
        WriteResource("HurogiCollector.Ui.agent_automation.html", Path.Combine(root, "agent_automation.html"));
        WriteResource("HurogiCollector.Ui.byeollog_logo_dark_safe.png", Path.Combine(root, "byeollog_logo_dark_safe.png"));
        WriteResource("HurogiCollector.Ui.byeollog_logo_light_safe.png", Path.Combine(root, "byeollog_logo_light_safe.png"));
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
