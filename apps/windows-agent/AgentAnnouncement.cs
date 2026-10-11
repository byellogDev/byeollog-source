using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal sealed record AgentAnnouncement(DateTimeOffset PublishedAt, string Path)
{
    public DateTimeOffset ExpiresAt => PublishedAt.AddHours(72);
    public string Label => "새로운 공지가 있어요! (" + PublishedAt.ToOffset(TimeSpan.FromHours(9)).ToString("M/d", CultureInfo.InvariantCulture) + ")";
    public Uri Url => new("https://byeollog.com" + Path);

    public static AgentAnnouncement[] Parse(string json)
    {
        if (json.Length > 32768) return [];
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.GetProperty("schemaVersion").GetInt32() != 1) return [];
            return root.GetProperty("notices").EnumerateArray().Take(50).Select(item =>
            {
                var path = item.GetProperty("path").GetString() ?? "";
                var timestamp = item.GetProperty("publishedAt").GetString() ?? "";
                if (!Regex.IsMatch(path, @"^/announcements/[a-z0-9][a-z0-9-]{0,100}$")
                    || !Regex.IsMatch(timestamp, @"(Z|[+-]\d{2}:\d{2})$")
                    || !DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.None, out var published)
                    || published.Year > 9998) return null;
                return new AgentAnnouncement(published, path);
            }).OfType<AgentAnnouncement>().OrderByDescending(n => n.PublishedAt).ToArray();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        { return []; }
    }
}

internal sealed class AgentAnnouncementClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly TimeProvider _clock;
    private DateTimeOffset _nextCheck = DateTimeOffset.MinValue;
    private AgentAnnouncement[] _notices = [];
    private bool _refreshing;
    public AgentAnnouncementClient(HttpClient? http = null, TimeProvider? clock = null)
    {
        _http = http ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        _http.Timeout = TimeSpan.FromSeconds(5);
        _http.MaxResponseContentBufferSize = 32768;
        _clock = clock ?? TimeProvider.System;
    }
    public AgentAnnouncement? Active => _notices.FirstOrDefault(n => n.PublishedAt <= _clock.GetUtcNow() && _clock.GetUtcNow() < n.ExpiresAt);
    // Called on the UI thread. Network work never blocks collection or startup.
    public async Task RefreshIfDueAsync()
    {
        var now = _clock.GetUtcNow();
        if (_refreshing || now < _nextCheck) return;
        _refreshing = true;
        _nextCheck = now.AddMinutes(30);
        try
        {
            using var response = await _http.GetAsync("https://byeollog.com/announcements/feed.json");
            response.EnsureSuccessStatusCode();
            _notices = AgentAnnouncement.Parse(await response.Content.ReadAsStringAsync());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or ObjectDisposedException) { }
        finally { _refreshing = false; }
    }
    public void Dispose() => _http.Dispose();
}
