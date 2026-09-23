using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperVisibilityRevisionTestsAsync(string root)
    {
        var path = Path.Combine(root, "visibility-revision");
        Directory.CreateDirectory(path);
        const string id = "11111111-1111-4111-8111-111111111111";
        const string session = "22222222-2222-4222-8222-222222222222";
        long revision = 9;
        var keys = new[] { "donation:1" };
        var writes = new List<string>();
        var selectedSession = session;
        var changeDuringRead = false;
        var layoutX = 0; var layoutY = 0; var layoutRows = 1;
        JsonElement Editor() => JsonSerializer.SerializeToElement(new
        {
            revision, selectedSessionIds = new[] { selectedSession }, displayKey = selectedSession,
            visibility = new { visibleKeys = keys },
            catalog = new[] { new { key = "donation:1", amount = 1, count = 1, displayKind = "donation" } },
            groups = new[] { new { id = "wallpaper-amount-1", tileIds = new[] { id }, cards = Array.Empty<object>(), x = layoutX, y = layoutY, width = 240, height = 226, layoutColumns = 2, layoutRows } }
        });
        using var wallpaper = new WallpaperOverlayState(path, _ => { });
        var overlay = JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { new { id, imageKey = (string?)null, imageUrl = (string?)null, groupKey = "wallpaper-amount-1", amount = 1, actorName = "fixture", layout = (object?)null } }
        });
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, revision, false, overlay), CancellationToken.None);
        Task<JsonElement> Remote(JsonElement? control, CancellationToken token)
        {
            if (control is null)
            {
                var response = Editor();
                if (changeDuringRead) { changeDuringRead = false; revision++; }
                return Task.FromResult(response);
            }
            var action = control.Value.GetProperty("action").GetString()!;
            var expected = control.Value.GetProperty("expectedRevision").GetInt64();
            writes.Add(action + ":" + expected);
            if (expected != revision) throw new VNextDevelopmentException { StatusCode = 409, Code = "wallpaper_revision_conflict" };
            if (action == "save-visibility") keys = control.Value.GetProperty("visibleKeys").EnumerateArray().Select(x => x.GetString()!).ToArray();
            if (action == "save-layout")
            {
                var tile = control.Value.GetProperty("tiles")[0];
                layoutX = tile.GetProperty("x").GetInt32(); layoutY = tile.GetProperty("y").GetInt32(); layoutRows = tile.GetProperty("rows").GetInt32();
            }
            revision++;
            return Task.FromResult(Editor());
        }
        using var coordinator = new WallpaperEditorCoordinator(() => true, Remote, () => 1, wallpaper, path, _ => { }, new EditorTestClock());
        await coordinator.GetStateAsync(CancellationToken.None);
        await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-layout", expectedRevision = 9,
            tiles = new[] { new { id, x = 100, y = 80, width = 240, height = 226, columns = 2, rows = 3, nextSide = "right", layer = 1 } }
        }), CancellationToken.None);
        var result = await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-visibility", expectedRevision = 9, visibleKeys = Array.Empty<string>()
        }), CancellationToken.None);
        Equal(0, result.GetProperty("visibility").GetProperty("visibleKeys").GetArrayLength(), "visibility click survives its own pre-save backup");
        Equal("save-layout:9,save-visibility:10", string.Join(",", writes), "visibility uses the revision acknowledged by its own preceding backup");
        Equal(11L, revision, "exactly one backup and one visibility save");
        await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-layout", expectedRevision = 11,
            tiles = new[] { new { id, x = 110, y = 80, width = 240, height = 226, columns = 2, rows = 3, nextSide = "right", layer = 1 } }
        }), CancellationToken.None);
        await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-visibility", expectedRevision = 11, visibleKeys = new[] { "donation:1" }
        }), CancellationToken.None);
        Equal(13L, revision, "next click works before the OBS snapshot catches up");
        Equal("save-layout:11,save-visibility:12", string.Join(",", writes.TakeLast(2)), "second local edit and visibility save use the acknowledged baseline");
        revision++; // A donation changes the shared revision, but not the display choice.
        await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-visibility", expectedRevision = 13, visibleKeys = Array.Empty<string>()
        }), CancellationToken.None);
        Equal(15L, revision, "donation-only revision changes do not reject a visibility click");

        keys = new[] { "donation:33" }; revision++;
        var before = writes.Count;
        try
        {
            await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
            {
                action = "save-visibility", expectedRevision = 15, visibleKeys = new[] { "donation:1" }
            }), CancellationToken.None);
            True(false, "another editor's visibility change must conflict");
        }
        catch (VNextDevelopmentException error) { Equal(409, error.StatusCode, "real visibility conflict remains 409"); }
        Equal("donation:33", keys.Single(), "another editor's visibility choice is preserved");
        Equal(before + 1, writes.Count, "conflicts are not automatically retried");
        await coordinator.RefreshAsync(CancellationToken.None);
        selectedSession = "33333333-3333-4333-8333-333333333333"; revision++;
        try
        {
            await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
            {
                action = "save-visibility", expectedRevision = 16, visibleKeys = new[] { "donation:1" }
            }), CancellationToken.None);
            True(false, "another broadcast selection must conflict");
        }
        catch (VNextDevelopmentException error) { Equal(409, error.StatusCode, "broadcast selection conflict remains 409"); }
        Equal("donation:33", keys.Single(), "selection conflict preserves visibility");
        await coordinator.RefreshAsync(CancellationToken.None);
        if (wallpaper.PendingLayout() is { } pending)
            await wallpaper.ClearPendingLayoutAsync(pending.Generation, CancellationToken.None);
        changeDuringRead = true;
        try
        {
            await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
            {
                action = "save-visibility", expectedRevision = 17, visibleKeys = Array.Empty<string>()
            }), CancellationToken.None);
            True(false, "concurrent write after fresh read must still conflict");
        }
        catch (VNextDevelopmentException error) { Equal(409, error.StatusCode, "final server CAS still protects concurrent changes"); }
        Equal("donation:33", keys.Single(), "no blind retry after fresh-read race");
    }
}
