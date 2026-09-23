using System.Net;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperPartialAssetRecoveryTestsAsync(string root)
    {
        var path = Path.Combine(root, "partial-asset-recovery");
        Directory.CreateDirectory(path);
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlCIAAAAASUVORK5CYII=");
        var failing = true;
        var handler = new ScriptedWallpaperHandler(uri => uri.AbsolutePath.Contains("missing") && failing
            ? new HttpResponseMessage(HttpStatusCode.BadGateway)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(png) });
        const string id = "11111111-1111-4111-8111-111111111111";
        JsonElement State(long revision) => JsonSerializer.SerializeToElement(new {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { id, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333" }
                .Select((tileId, index) => new { id = tileId, groupKey = "amount-100", actorName = "fixture", amount = 100,
                    imageKey = index < 2 ? "missing" : "healthy",
                    imageUrl = "https://stimg.sooplive.com/" + (index < 2 ? "missing" : "healthy") + ".png" })
        });
        var clock = new EditorTestClock();
        using var wallpaper = new WallpaperOverlayState(path, _ => { }, handler, null, clock);
        True(await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, State(9)), CancellationToken.None), "partial snapshot is displayed");
        Equal(2, handler.Requests.Count, "duplicate failed image is attempted only once per snapshot");
        Equal(0L, wallpaper.Revision, "partial snapshot preserves the acknowledged cursor");
        using (var partial = JsonDocument.Parse(wallpaper.SnapshotBytes()))
        {
            Equal(3, partial.RootElement.GetProperty("tiles").GetArrayLength(), "healthy and pending cards are retained");
            Equal(2, partial.RootElement.GetProperty("pendingAssetCount").GetInt32(), "pending image count is explicit");
            True(partial.RootElement.GetProperty("tiles")[2].GetProperty("imageUrl").GetString()!.StartsWith("/overlay/wallpaper-assets/"), "healthy image is available immediately");
        }
        await wallpaper.ApplyLocalLayoutAsync(9, JsonSerializer.SerializeToElement(new[] {
            new { id, x = 500, y = 80, width = 240, height = 226, columns = 1, rows = 3, nextSide = "right", layer = 1 }
        }), null, CancellationToken.None);
        using (var restored = new WallpaperOverlayState(path, _ => { }))
        {
            Equal(0L, restored.Revision, "restart retries incomplete images");
            True(restored.HasPendingAssets, "restart retains pending status");
        }
        False(await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 8, false, State(8)), CancellationToken.None), "older snapshot cannot replace newer partial display");
        failing = false;
        clock.Advance(6);
        var requestsBeforeRecovery = handler.Requests.Count;
        True(await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, State(9)), CancellationToken.None), "same revision repairs the failed image");
        Equal(1, handler.Requests.Count - requestsBeforeRecovery, "recovery reuses healthy cache and deduplicates missing image");
        Equal(9L, wallpaper.Revision, "only complete recovery acknowledges the server cursor");
        False(wallpaper.HasPendingAssets, "recovery clears pending status");
        using var recovered = JsonDocument.Parse(wallpaper.SnapshotBytes());
        Equal(500, recovered.RootElement.GetProperty("tiles")[0].GetProperty("layout").GetProperty("x").GetInt32(), "local edits survive asset recovery");
        var beforeCancellation = wallpaper.SnapshotBytes();
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await ThrowsAsync<OperationCanceledException>(() => wallpaper.ApplyAsync(new VNextWallpaperSync(true, 10, false, State(10)), canceled.Token), "real shutdown cancellation is not swallowed as image failure");
        True(beforeCancellation.SequenceEqual(wallpaper.SnapshotBytes()), "canceled apply leaves display unchanged");
        Console.WriteLine("PASS: partial assets, deduplication, recovery, restart, stale response, local edits, cancellation");
    }
}
