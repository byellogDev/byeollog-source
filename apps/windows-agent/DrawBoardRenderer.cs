namespace HurogiCollector;

internal static class DrawBoardRenderer
{
    internal static readonly byte[] Html = Load();
    private static byte[] Load()
    {
        using var stream = typeof(DrawBoardRenderer).Assembly.GetManifestResourceStream("HurogiCollector.Ui.draw-board-overlay.html")
            ?? throw new InvalidOperationException("뽑기판 표시 리소스가 없습니다.");
        using var output = new MemoryStream();
        stream.CopyTo(output);
        return output.ToArray();
    }
}
