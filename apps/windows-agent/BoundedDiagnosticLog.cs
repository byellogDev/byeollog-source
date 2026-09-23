using System.Text;

namespace HurogiCollector;

internal static class BoundedDiagnosticLog
{
    private static readonly object Gate = new();
    internal static void Append(string path, string line)
    {
        lock (Gate)
        {
            try
            {
                if (File.Exists(path) && new FileInfo(path).Length >= 10 * 1024 * 1024)
                {
                    for (var index = 2; index >= 1; index--)
                        if (File.Exists(path + "." + index)) File.Move(path + "." + index, path + "." + (index + 1), true);
                    File.Move(path, path + ".1", true);
                }
                File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
