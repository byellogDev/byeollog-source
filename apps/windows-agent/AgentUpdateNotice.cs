using System.Text.Json;

namespace HurogiCollector;

// The updater runs after the main window starts. Refresh its result without
// reading a file on every UI status tick or creating another network poll.
internal sealed class AgentUpdateNoticeCache(Func<string> read, TimeProvider? clock = null)
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private DateTimeOffset _nextRead = DateTimeOffset.MinValue;
    private string _value = "";
    internal string Get()
    {
        if (_clock.GetUtcNow() < _nextRead) return _value;
        _value = read();
        _nextRead = _clock.GetUtcNow().AddSeconds(10);
        return _value;
    }
}

internal static class AgentUpdateNotice
{
    internal static string ReadCurrent() => Read(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ByeollogAgent", "updates", "update-state.json"), BuildInfo.Version);

    internal static string Read(string path, string currentVersion)
    {
        try
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length is < 2 or > 65536) return "";
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var root = document.RootElement;
            var status = root.GetProperty("lastStatus").GetString();
            if (status is "failed_kept_current" or "blocked_after_rollback")
                return $"업데이트를 적용하지 못해 {currentVersion}으로 실행 중입니다. 홈페이지에서 최신 설치 파일을 받아주세요.";
            if (status == "installed_restart_required"
                && root.TryGetProperty("availableVersion", out var candidate)
                && Version.TryParse(candidate.GetString(), out var available)
                && Version.TryParse(currentVersion, out var current) && available > current)
                return $"업데이트가 준비됐지만 현재 {currentVersion}으로 실행 중입니다. 트레이에서 종료 후 다시 실행해주세요.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException) { }
        return "";
    }
}
