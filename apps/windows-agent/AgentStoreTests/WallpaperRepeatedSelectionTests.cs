using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    // Real coordinator, state store and localhost HTTP endpoint.
    // Only the remote session service is a fixture; this is not customer OBS E2E.
    private static async Task WallpaperRepeatedSelectionTestsAsync(string root)
    {
        var storage = new CollectorStorage(Path.Combine(root, "repeated-selection"));
        using var wallpaper = new WallpaperOverlayState(storage.RootPath, _ => { });
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        using var service = new ByeollogOverlayService(storage, new OverlayAssetCache(storage.RootPath), wallpaper, port);
        True(service.TryStart(), "isolated overlay HTTP service starts");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        long revision = 1;
        string[] selected = [];
        JsonElement Editor() => JsonSerializer.SerializeToElement(new { revision, selectedSessionIds = selected, groups = Array.Empty<object>() });
        JsonElement Snapshot() => JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = selected.Select((session, i) => new
            {
                id = i == 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
                actorName = "fixture", amount = 33, imageUrl = (string?)null, imageKey = (string?)null
            })
        });
        TaskCompletionSource? entered = null, release = null;
        async Task<JsonElement> Remote(JsonElement? control, CancellationToken token)
        {
            if (control is not null)
            {
                Equal("select-sessions", control.Value.GetProperty("action").GetString(), "fixture only selects sessions");
                entered?.TrySetResult();
                if (release is not null) await release.Task.WaitAsync(token);
                selected = control.Value.GetProperty("sessionIds").EnumerateArray().Select(x => x.GetString()!).ToArray();
                revision++;
            }
            return Editor();
        }
        using var coordinator = new WallpaperEditorCoordinator(() => true, Remote, () => 1, wallpaper, storage.RootPath, _ => { });
        await coordinator.GetStateAsync(CancellationToken.None);
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, revision, false, Snapshot()), CancellationToken.None);
        for (var i = 0; i < 48; i++)
        {
            string[] wanted = (i % 3) switch { 0 => ["session-a"], 1 => ["session-a", "session-b"], _ => [] };
            var previous = string.Join(',', selected);
            entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var change = coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new { action = "select-sessions", sessionIds = wanted }), CancellationToken.None);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var whilePending = await coordinator.GetStateAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1));
            Equal(previous, string.Join(',', whilePending.GetProperty("selectedSessionIds").EnumerateArray().Select(x => x.GetString())), "pending selection keeps last confirmed local state readable");
            release.TrySetResult();
            var acknowledged = await change.WaitAsync(TimeSpan.FromSeconds(2));
            Equal(string.Join(',', wanted), string.Join(',', acknowledged.GetProperty("selectedSessionIds").EnumerateArray().Select(x => x.GetString())), "selection ACK matches latest request");
            // Model the independent snapshot delivery after the control ACK.
            await wallpaper.ApplyAsync(new VNextWallpaperSync(true, revision, false, Snapshot()), CancellationToken.None);
            using var actualHttp = JsonDocument.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/overlay/wallpaper-state"));
            Equal(wanted.Length, actualHttp.RootElement.GetProperty("tiles").GetArrayLength(), "actual overlay endpoint follows selection including complete deselection");
        }
        Console.WriteLine("REPEATED_SELECTION: 48 transitions, 16 complete deselections; coordinator ACK and local HTTP tiles agree after snapshot delivery. Remote transport and OBS browser rendering not exercised.");
    }
}
