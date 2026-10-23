namespace HurogiCollector;

internal static class WallpaperBaekdusanRenderer
{
    internal static readonly string Script = Load("wallpaper-hidden.js") + "\n" + Load("wallpaper-appearance.js") + "\n" + Load("wallpaper-baekdusan.js") + "\n" + Load("wallpaper-detached.js");
    private static string Load(string file)
    {
        using var stream = typeof(WallpaperBaekdusanRenderer).Assembly.GetManifestResourceStream("HurogiCollector.Ui." + file)
            ?? throw new InvalidOperationException("백두산 표시 리소스가 없습니다.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
