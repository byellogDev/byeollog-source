using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperSizeRuleTestsAsync(string root, bool serve = false)
    {
        await WallpaperResizeBoundsTestsAsync(root);
        const string workspace = "11111111-1111-4111-8111-111111111111";
        var raw = JsonSerializer.SerializeToElement(new {
            changed = true, revision = 41,
            overlay = new { visibleGroupKeys = new[] { "donation:330" }, mergeRanges = Array.Empty<object>(),
                sizeRanges = new[] { new { min = 330, max = 330, width = 360 }, new { min = 99, max = 1, width = 999 } } },
            sessions = new[] { new { canvasWidth = 1920, canvasHeight = 1080, startedAt = "2026-09-05T08:00:00Z" } },
            tiles = Enumerable.Range(1, 3).Select(i => new { id = $"00000000-0000-4000-8000-{i:D12}",
                sequenceNo = i, sessionId = workspace, amount = 330, actorName = "별친구" + i,
                displayKind = "donation", assetSource = "signature", layoutX = (int?)null,
                layoutY = (int?)null, layoutWidth = (int?)null, layoutHeight = (int?)null }),
            signatures = Array.Empty<object>()
        });
        var sync = AgentWallpaperSnapshotMapper.Build(raw, workspace, "https://offslvwaugvjotkywlus.supabase.co");
        Equal(1, sync.State!.Value.GetProperty("sizeRanges").GetArrayLength(), "mapper keeps valid bounded size rule only");
        Equal(360, sync.State.Value.GetProperty("sizeRanges")[0].GetProperty("width").GetInt32(), "mapper forwards configured 330 width");
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlCIAAAAASUVORK5CYII=");
        using var handler = new ScriptedWallpaperHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(png) });
        var path = Path.Combine(root, "size-rules");
        using var wallpaper = new WallpaperOverlayState(path, _ => { }, handler);
        await wallpaper.ApplyAsync(sync, CancellationToken.None);
        using (var restored = new WallpaperOverlayState(path, _ => { }))
        {
            Equal(41L, restored.Revision, "size-aware cache keeps acknowledged cursor after restart");
            using var state = JsonDocument.Parse(restored.SnapshotBytes());
            Equal(360, state.RootElement.GetProperty("sizeRanges")[0].GetProperty("width").GetInt32(), "rules survive offline restart");
        }
        if (serve)
        {
            using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            listener.Start();var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
            var storage = new CollectorStorage(path);
            using var service = new ByeollogOverlayService(storage, new OverlayAssetCache(path), wallpaper, port);
            True(service.TryStart(), "size-rule isolated overlay starts");
            Console.WriteLine("SIZE_RULE_OVERLAY_URL=" + service.WallpaperOverlayUrl);
            await Task.Delay(TimeSpan.FromSeconds(300));
        }
        var legacy = JsonNode.Parse(sync.State.Value.GetRawText())!;
        legacy.AsObject().Remove("sizeRanges"); legacy["revision"] = 42;
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 42, false, JsonSerializer.SerializeToElement(legacy)), CancellationToken.None);
        using (var upgraded = new WallpaperOverlayState(path, _ => { }))
        {
            Equal(42L, upgraded.Revision, "old cache keeps its acknowledged cursor");
            Equal(42L, upgraded.SyncRevision, "local display rules keep the synced cursor after a server snapshot without rules");
            using var display = JsonDocument.Parse(upgraded.SnapshotBytes());
            Equal(3, display.RootElement.GetProperty("tiles").GetArrayLength(), "upgrade does not blank cached overlay");
            Equal(360, display.RootElement.GetProperty("sizeRanges")[0].GetProperty("width").GetInt32(),
                "server snapshots without size rules preserve local size settings");
        }
        Console.WriteLine("PASS: mapper -> local state -> offline restart -> local size rules preserved");
    }

    private static async Task WallpaperResizeBoundsTestsAsync(string root)
    {
        // Payloads produced by the editor regression fixtures: right-edge rounding,
        // a dense stack, and a compact group aligned to the bottom of the canvas.
        var layouts = new[]
        {
            new { id = "00000000-0000-4000-8000-000000000001", x = 0, y = 0, width = 1911, height = 139, columns = 13, rows = 1, nextSide = "right", layer = 1 },
            new { id = "00000000-0000-4000-8000-000000000002", x = 0, y = 0, width = 134, height = 1078, columns = 2, rows = 80, nextSide = "right", layer = 2 },
            new { id = "00000000-0000-4000-8000-000000000003", x = 1440, y = 1020, width = 480, height = 60, columns = 2, rows = 1, nextSide = "right", layer = 3 }
        };
        var payload = JsonSerializer.SerializeToElement(layouts);
        Equal(3, WallpaperOverlayState.NormalizeLayoutTiles(payload).Count, "resized editor geometry passes real Agent validation");
        foreach (var invalid in new[] { layouts[0] with { width = 1924 }, layouts[1] with { height = 1287 }, layouts[2] with { y = 1034 } })
        {
            var rejected = false;
            try { WallpaperOverlayState.NormalizeLayoutTiles(JsonSerializer.SerializeToElement(new[] { invalid })); }
            catch (InvalidDataException) { rejected = true; }
            True(rejected, "actual out-of-bounds geometry is still rejected");
        }
        var path = Path.Combine(root, "resize-bounds");
        string generation;
        using (var state = new WallpaperOverlayState(path, _ => { }))
        {
            generation = await state.ApplyLocalLayoutAsync(0, payload, payload, CancellationToken.None);
            Equal(3, state.PendingLayout()!.Tiles.GetArrayLength(), "all corrected groups persist together");
        }
        using var restored = new WallpaperOverlayState(path, _ => { });
        Equal(generation, restored.PendingLayout()!.Generation, "corrected layout survives offline restart");
        Equal(payload.GetRawText(), restored.PendingLayout()!.Tiles.GetRawText(), "restart preserves exact coordinates and layout members");
    }
}
