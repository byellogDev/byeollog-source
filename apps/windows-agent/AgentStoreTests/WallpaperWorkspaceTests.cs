using System.Text.Json;
using System.Net;
using System.Net.Sockets;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperWorkspaceTestsAsync(string root)
    {
        var path = Path.Combine(root, "workspace-boundary"); Directory.CreateDirectory(path);
        var a = Guid.NewGuid().ToString("D"); var b = Guid.NewGuid().ToString("D");
        var tileA = Guid.NewGuid().ToString("D"); var tileB = Guid.NewGuid().ToString("D");
        JsonElement Snapshot(long revision, string id) => JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { new { id, amount = 33, actorName = "fixture", imageUrl = (string?)null, imageKey = (string?)null, groupKey = "amount-33" } }
        });
        JsonElement Layout(string id, long revision, int x) => JsonSerializer.SerializeToElement(new
        {
            action = "save-layout", expectedRevision = revision,
            tiles = new[] { new { id, x, y = 10, width = 240, height = 226, columns = 1, rows = 1, nextSide = "right", layer = 1 } }
        });
        using (var legacy = new WallpaperOverlayState(path, _ => { }))
        {
            await legacy.ApplyAsync(new(true, 100, false, Snapshot(100, tileA)), CancellationToken.None);
            using var editor = new WallpaperEditorCoordinator(() => false, (_, _) => throw new Exception("offline"), () => 1, legacy, path, _ => { });
            await editor.ApplyAsync(Layout(tileA, 100, 321), CancellationToken.None);
        }
        var original = File.ReadAllBytes(Path.Combine(path, "wallpaper-overlay-state-v1.json"));
        string active = b; bool online = true; int proofCalls = 0, writes = 0;
        WallpaperWorkspaceContext Make(string id, Task? previous = null) => new(path, id, () => online && active == id,
            (control, token) =>
            {
                token.ThrowIfCancellationRequested();
                if (control?.GetProperty("action").GetString() == "verify-cache-ownership")
                {
                    proofCalls++;
                    return Task.FromResult(JsonSerializer.SerializeToElement(new { owned = id == a, workspaceId = id }));
                }
                if (control is not null) writes++;
                return Task.FromResult(JsonSerializer.SerializeToElement(new { revision = id == a ? 100 : 1, groups = Array.Empty<object>(), selectedSessionIds = Array.Empty<string>() }));
            }, () => active == id ? 1 : 2, _ => { }, () => { }, priorRetirement: previous);
        using var contextB = Make(b);
        await contextB.PrepareAsync(CancellationToken.None);
        using (var empty = JsonDocument.Parse(contextB.State.SnapshotBytes()))
            Equal(0, empty.RootElement.GetProperty("tiles").GetArrayLength(), "B never loads A legacy tiles");
        True(contextB.State.PendingLayout() is null, "B never loads A pending edits");
        await contextB.State.ApplyAsync(new(true, 1, false, Snapshot(1, tileB)), CancellationToken.None);
        Equal(1L, contextB.State.Revision, "A high revision cannot block B low revision");
        active = a;
        using var contextA = Make(a);
        await contextA.PrepareAsync(CancellationToken.None);
        Equal(100L, contextA.State.Revision, "owned legacy revision copied");
        Equal(321, contextA.State.PendingLayout()!.Tiles[0].GetProperty("x").GetInt32(), "unsent legacy layout preserved");
        True(original.SequenceEqual(File.ReadAllBytes(Path.Combine(path, "wallpaper-overlay-state-v1.json"))), "legacy snapshot preserved byte for byte");
        True(!File.Exists(Path.Combine(contextA.RootPath, "wallpaper-editor-cache-v1.json")), "unowned editor metadata is rebuilt, not copied");
        Equal(0, writes, "migration performs no server writes");
        online = false;
        contextA.Dispose(); await contextA.Retired;
        using var restarted = Make(a, contextA.Retired);
        await restarted.PrepareAsync(CancellationToken.None);
        Equal(321, restarted.State.PendingLayout()!.Tiles[0].GetProperty("x").GetInt32(), "offline restart restores own pending layout");
        await restarted.Editor.ApplyAsync(Layout(tileA, 100, 444), CancellationToken.None);
        Equal(444, restarted.State.PendingLayout()!.Tiles[0].GetProperty("x").GetInt32(), "offline local editing retained");
        Equal(2, proofCalls, "scoped cache restarts never revalidate legacy over network");
        active = b;
        restarted.Dispose(); await restarted.Retired;
        var cancelled = false;
        try { await restarted.Editor.ApplyAsync(Layout(tileA, 100, 999), CancellationToken.None); }
        catch (OperationCanceledException) { cancelled = true; }
        True(cancelled, "retired editor rejects late edits");
        Equal(1L, contextB.State.Revision, "late A operations cannot change B");
        contextB.Dispose(); await contextB.Retired;
        await WallpaperWorkspaceInFlightTestAsync(Path.Combine(root, "workspace-inflight"));
        Console.WriteLine("WORKSPACE_CACHE: foreign legacy excluded; owned snapshot/pending copied; originals kept; A100/B1 independent; offline restart/edit; retired operations cancelled.");
    }

    private static async Task WallpaperWorkspaceInFlightTestAsync(string root)
    {
        Directory.CreateDirectory(root);
        var a = Guid.NewGuid().ToString("D"); var b = Guid.NewGuid().ToString("D");
        var tile = Guid.NewGuid().ToString("D"); string active = a;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var writesEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        WallpaperWorkspaceContext Make(string id) => new(root, id, () => active == id,
            async (control, token) =>
            {
                if (control is not null) { writesEntered.TrySetResult(); await releaseWrite.Task; }
                return JsonSerializer.SerializeToElement(new { revision = 999, groups = Array.Empty<object>(), selectedSessionIds = Array.Empty<string>() });
            }, () => active == id ? 1 : 2, _ => { }, () => { });
        using var old = Make(a); await old.PrepareAsync(CancellationToken.None);
        var snapshot = JsonSerializer.SerializeToElement(new { schemaVersion = 1, revision = 8, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { new { id = tile, amount = 33, imageUrl = (string?)null, imageKey = (string?)null } } });
        await old.State.ApplyAsync(new(true, 8, false, snapshot), CancellationToken.None);
        var control = JsonSerializer.SerializeToElement(new { action = "select-sessions", sessionIds = Array.Empty<string>() });
        var lateWrite = old.Editor.ApplyAsync(control, CancellationToken.None);
        await writesEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        old.Applications = new WallpaperApplicationQueue(async (sync, _, token) =>
        {
            entered.TrySetResult(); await release.Task;
            await old.State.ApplyAsync(sync, token);
        });
        old.Applications.Enqueue(new(true, 9, false, snapshot), 1, old.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        using var next = Make(b); await next.PrepareAsync(CancellationToken.None);
        var storage = new CollectorStorage(root);
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        using var server = new ByeollogOverlayService(storage, new OverlayAssetCache(root), old.State, port);
        server.WallpaperStateProvider = () => active == a ? old.State : next.State;
        True(server.TryStart(), "workspace switching keeps localhost listener alive");
        using var http = new HttpClient();
        active = b; old.Dispose();
        using (var response = JsonDocument.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/overlay/wallpaper-state")))
            Equal(0, response.RootElement.GetProperty("tiles").GetArrayLength(), "HTTP switches to B while A operations still stalled");
        True(!old.Retired.IsCompleted, "retirement drains active operations before disposing state");
        release.TrySetResult(); releaseWrite.TrySetResult();
        var cancelled = false;
        try { await lateWrite; } catch (OperationCanceledException) { cancelled = true; }
        True(cancelled, "late A control response rejected after account change");
        await old.Retired.WaitAsync(TimeSpan.FromSeconds(3));
        Equal(0L, next.State.Revision, "old queue and ACK cannot modify B state");
        True(!File.Exists(Path.Combine(next.RootPath, "wallpaper-editor-cache-v1.json")), "old ACK cannot create B editor cache");
        next.Dispose(); await next.Retired;
    }
}
