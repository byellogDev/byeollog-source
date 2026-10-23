using System.Net;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private sealed class NoticeClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private sealed class NoticeHandler : HttpMessageHandler
    {
        public string Body = "";
        public int Calls;
        public bool Fail;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Equal("https://byeollog.com/announcements/feed.json", request.RequestUri!.AbsoluteUri, "public feed fixed origin");
            True(request.Headers.Authorization is null, "announcement request has no user credentials");
            if (Fail) throw new HttpRequestException("offline");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Body) });
        }
    }
    private static async Task AnnouncementTestsAsync()
    {
        var published = DateTimeOffset.Parse("2026-10-11T20:00:00+09:00");
        string Feed(string path = "/announcements/2026-10-11-upbo-collection", DateTimeOffset? date = null) =>
            JsonSerializer.Serialize(new { schemaVersion = 1, notices = new[] { new { publishedAt = (date ?? published).ToString("O"), path } } });
        foreach (var path in new[] { "https://evil.example/announcements/a", "//evil.example", "/announcements/../login", "/announcements/a?token=x", "/announcements/a#x", "/announcements/%2e%2e/login", "/announcements/a\\b" })
            Equal(0, AgentAnnouncement.Parse(Feed(path)).Length, "unsafe notice destination rejected");
        Equal(0, AgentAnnouncement.Parse("not json").Length, "malformed feed ignored");
        Equal(0, AgentAnnouncement.Parse(new string(' ', 32769)).Length, "oversized feed ignored");
        var clock = new NoticeClock(published.AddSeconds(-1));
        var handler = new NoticeHandler { Body = Feed() };
        using var client = new AgentAnnouncementClient(new HttpClient(handler), clock);
        await client.RefreshIfDueAsync();
        True(client.Active is null, "future announcement hidden");
        clock.Now = published;
        Equal("새로운 공지가 있어요! (10/11)", client.Active!.Label, "publication instant visible with Korean date");
        await client.RefreshIfDueAsync();
        Equal(1, handler.Calls, "repeated UI refresh does not fetch feed again");
        clock.Now = published.AddHours(72).AddMilliseconds(-1);
        handler.Fail = true;
        await client.RefreshIfDueAsync();
        True(client.Active is not null, "network outage keeps valid cached notice");
        clock.Now = published.AddHours(72);
        True(client.Active is null, "exactly 72 hours hidden even offline");
        clock.Now = published.AddDays(5);
        handler.Fail = false;
        handler.Body = Feed(date: clock.Now);
        await client.RefreshIfDueAsync();
        Equal("새로운 공지가 있어요! (10/16)", client.Active!.Label, "future publications reuse client without update");
        clock.Now = clock.Now.AddMinutes(30);
        handler.Body = "{\"schemaVersion\":1,\"notices\":[]}";
        await client.RefreshIfDueAsync();
        True(client.Active is null, "withdrawn notice cleared after successful refresh");
        var ordered = AgentAnnouncement.Parse(JsonSerializer.Serialize(new { schemaVersion = 1, notices = new[] {
            new { publishedAt = published.ToString("O"), path = "/announcements/old" },
            new { publishedAt = published.AddHours(1).ToString("O"), path = "/announcements/new" } } }));
        Equal("/announcements/new", ordered[0].Path, "newest publication has priority");
    }
}
