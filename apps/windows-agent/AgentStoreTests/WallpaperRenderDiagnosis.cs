using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    // Isolated reproduction: real state writer and HTTP overlay, no account or production data.
    private static async Task DiagnoseWallpaperRenderAsync(string root, bool serve = false)
    {
        await DiagnoseEmptyWallpaperAsync(Path.Combine(root, "failed-image"));
        var storage = new CollectorStorage(root);
        using var wallpaper = new WallpaperOverlayState(root, _ => { });
        const string id = "11111111-1111-4111-8111-111111111111";
        var initial = JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1, revision = 9, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { new {
                id, imageKey = (string?)null, imageUrl = (string?)null,
                groupKey = "wallpaper-amount-100", amount = 100, actorName = "fixture",
                layout = new { x = 100, y = 80, width = 240, height = 226,
                    columns = 1, rows = 1, nextSide = "right", layer = 1 }
            } }
        });
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, initial), CancellationToken.None);
        int port;
        using (var listener = new TcpListener(IPAddress.Loopback, 0))
        {
            listener.Start();
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        using var overlay = new ByeollogOverlayService(storage, new OverlayAssetCache(root), wallpaper, port);
        bool startedWhilePortOccupied;
        using (var blocker = new TcpListener(IPAddress.Loopback, port))
        {
            blocker.Server.ExclusiveAddressUse = true;
            blocker.Start();
            startedWhilePortOccupied = overlay.TryStart();
        }
        var runningAfterPortReleased = overlay.IsRunning;
        if (!overlay.TryStart()) throw new InvalidOperationException("Diagnostic overlay could not start.");
        using var http = new HttpClient();
        var stateUrl = $"http://127.0.0.1:{port}/overlay/wallpaper-state";
        async Task<int> RequestStatus(string? fetchSite, string? origin)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, overlay.WallpaperOverlayUrl);
            if (fetchSite is not null) request.Headers.TryAddWithoutValidation("Sec-Fetch-Site", fetchSite);
            if (origin is not null) request.Headers.TryAddWithoutValidation("Origin", origin);
            using var response = await http.SendAsync(request);
            return (int)response.StatusCode;
        }
        var environmentChecks = new {
            startedWhilePortOccupied,
            runningAfterPortReleased,
            recoveredAfterExplicitStart = overlay.IsRunning,
            directNavigation = await RequestStatus("none", null),
            olderClientWithoutFetchHeaders = await RequestStatus(null, null),
            sameOriginRequest = await RequestStatus("same-origin", $"http://127.0.0.1:{port}"),
            crossSiteNavigation = await RequestStatus("cross-site", null),
            opaqueOriginRequest = await RequestStatus(null, "null")
        };
        using var before = JsonDocument.Parse(await http.GetStringAsync(stateUrl));
        await wallpaper.ApplyLocalLayoutAsync(9, JsonSerializer.SerializeToElement(new[] { new {
            id, x = 500, y = 80, width = 240, height = 226,
            columns = 1, rows = 1, nextSide = "right", layer = 1
        } }), null, CancellationToken.None);
        using var after = JsonDocument.Parse(await http.GetStringAsync(stateUrl));
        var html = await http.GetStringAsync(overlay.WallpaperOverlayUrl);
        Console.WriteLine("RENDER_DIAG=" + JsonSerializer.Serialize(new {
            before = before.RootElement, after = after.RootElement, html,
            serverRevision = wallpaper.Revision, environmentChecks
        }));
        if (serve)
        {
            Console.WriteLine("DIAGNOSTIC_URL=" + overlay.WallpaperOverlayUrl);
            await Task.Delay(TimeSpan.FromMinutes(5));
        }
    }

    private static async Task DiagnoseEmptyWallpaperAsync(string root)
    {
        Directory.CreateDirectory(root);
        var messages = new List<string>();
        using var handler = new ScriptedWallpaperHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        using var wallpaper = new WallpaperOverlayState(root, messages.Add, handler);
        const string id = "11111111-1111-4111-8111-111111111111";
        var card = new { id, groupKey = "wallpaper-amount-100", amount = 100, actorName = "fixture",
            imageKey = "fixture-failed-image", imageUrl = "https://stimg.sooplive.com/fixture.png" };
        var state = JsonSerializer.SerializeToElement(new { schemaVersion = 1, revision = 9,
            canvasWidth = 1920, canvasHeight = 1080, tiles = new[] { card } });
        var editorState = JsonSerializer.SerializeToElement(new { revision = 9,
            groups = new[] { new { id = "wallpaper-amount-100", tileIds = new[] { id }, cards = new[] { card } } } });
        using var editor = new WallpaperEditorCoordinator(() => true,
            (_, _) => Task.FromResult(editorState), () => 1, wallpaper, root, messages.Add);
        var visibleEditor = await editor.GetStateAsync(CancellationToken.None);
        string? applyFailure = null;
        try { await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, state), CancellationToken.None); }
        catch (IOException ex) { applyFailure = ex.GetType().Name; }
        await editor.ApplyAsync(JsonSerializer.SerializeToElement(new { action = "save-layout", expectedRevision = 9,
            tiles = new[] { new { id, x = 500, y = 80, width = 240, height = 226, columns = 1, rows = 1, nextSide = "right", layer = 1 } }
        }), CancellationToken.None);
        using var actual = JsonDocument.Parse(wallpaper.SnapshotBytes());
        var editorCards = visibleEditor.GetProperty("groups")[0].GetProperty("cards").GetArrayLength();
        var overlayCards = actual.RootElement.GetProperty("tiles").GetArrayLength();
        Equal(1, editorCards, "editor remains populated when overlay image download fails");
        Equal(1, overlayCards, "failed first image keeps a visible card after successful local edit");
        Equal(0L, wallpaper.Revision, "incomplete assets must not acknowledge the server cursor");
        True(wallpaper.HasPendingAssets, "failed image remains scheduled for recovery");
        Console.WriteLine("EMPTY_DIAG=" + JsonSerializer.Serialize(new { editorCards, overlayCards,
            localEditSucceeded = true, imageRequests = handler.Requests.Count, applyFailure, messages }));
    }
}
