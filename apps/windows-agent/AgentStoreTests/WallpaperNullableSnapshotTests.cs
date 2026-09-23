using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static VNextWallpaperSync WallpaperNullableSnapshotTests()
    {
        const string workspace = "11111111-1111-4111-8111-111111111111";
        // The production SQL uses jsonb_build_object: unarranged cards have
        // explicit JSON null fields, not omitted properties. Hurogi had 9/9.
        var raw = JsonSerializer.SerializeToElement(new {
            changed = true, revision = 1288,
            overlay = new { visibleGroupKeys = new[] { "donation:33" }, mergeRanges = Array.Empty<object>() },
            sessions = new[] { new { canvasWidth = 1920, canvasHeight = 1080, startedAt = "2026-09-05T08:00:00Z" } },
            tiles = Enumerable.Range(1,9).Select(i => new {
                id = $"00000000-0000-4000-8000-{i:D12}", sequenceNo = i, amount = 33,
                actorName = "fixture", displayKind = "donation", assetSource = "signature",
                asset = new { width = (int?)null, height = (int?)null, byteSize = (int?)null },
                layoutX = (int?)null, layoutY = (int?)null, layoutWidth = (int?)null,
                layoutHeight = (int?)null, layoutColumns = (int?)null, layoutRows = (int?)null,
                layoutLayer = (int?)null, layoutNextSide = (string?)null
            }),
            signatures = Array.Empty<object>()
        });
        var result = AgentWallpaperSnapshotMapper.Build(raw, workspace, "https://offslvwaugvjotkywlus.supabase.co");
        Equal(9, result.State!.Value.GetProperty("tiles").GetArrayLength(), "explicit SQL null layouts must not block all 9 cards");
        Equal(JsonValueKind.Null, result.State.Value.GetProperty("tiles")[0].GetProperty("layout").ValueKind,
            "unarranged SQL cards remain automatic layout");
        Console.WriteLine("PASS: production-shaped 9-card snapshot with explicit null layout fields");
        return result;
    }

    private static async Task ServeNullableWallpaperAsync(string root)
    {
        var sync = WallpaperNullableSnapshotTests();
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlCIAAAAASUVORK5CYII=");
        using var handler = new ScriptedWallpaperHandler(_ => new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) {
            Content = new System.Net.Http.ByteArrayContent(png) });
        using var wallpaper = new WallpaperOverlayState(root, _ => { }, handler);
        await wallpaper.ApplyAsync(sync, CancellationToken.None);
        using var state = JsonDocument.Parse(wallpaper.SnapshotBytes());
        Equal(9, state.RootElement.GetProperty("tiles").GetArrayLength(), "nullable snapshot reaches the actual local overlay state");
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        var storage = new CollectorStorage(root);
        using var service = new ByeollogOverlayService(storage, new OverlayAssetCache(root), wallpaper, port);
        True(service.TryStart(), "nullable wallpaper browser harness starts on an isolated port");
        Console.WriteLine("NULLABLE_DIAGNOSTIC_URL=" + service.WallpaperOverlayUrl);
        await Task.Delay(TimeSpan.FromSeconds(90));
    }
}
