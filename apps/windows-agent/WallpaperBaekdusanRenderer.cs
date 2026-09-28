namespace HurogiCollector;

internal static class WallpaperBaekdusanRenderer
{
    internal static readonly string Script = Load();
    private static string Load()
    {
        using var stream = typeof(WallpaperBaekdusanRenderer).Assembly.GetManifestResourceStream("HurogiCollector.Ui.wallpaper-baekdusan.js")
            ?? throw new InvalidOperationException("백두산 표시 리소스가 없습니다.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
