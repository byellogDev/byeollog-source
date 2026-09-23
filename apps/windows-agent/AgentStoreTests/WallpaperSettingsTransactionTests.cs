using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    private static async Task WallpaperSettingsTransactionTestsAsync(string root)
    {
        var directory = Path.Combine(root, "local-wallpaper-rules");
        Directory.CreateDirectory(directory);
        const string firstId = "11111111-1111-4111-8111-111111111111";
        const string secondId = "22222222-2222-4222-8222-222222222222";
        const string session = "33333333-3333-4333-8333-333333333333";
        long revision = 9;
        var writes = new List<string>();

        JsonElement Remote(JsonElement? control)
        {
            if (control is null) return JsonSerializer.SerializeToElement(new
            {
                revision,
                selectedSessionIds = new[] { session },
                displayKey = session,
                visibility = new { visibleKeys = new[] { "donation:33", "donation:100" } },
                merge = new { rules = Array.Empty<object>(), savedRules = Array.Empty<object>(), activeForCurrentUser = false },
                size = new { rules = Array.Empty<object>(), savedRules = Array.Empty<object>(), activeForCurrentUser = false },
                groups = new[]
                {
                    new { id = "wallpaper-amount-33", tileIds = new[] { firstId }, cards = Array.Empty<object>(), x = 0, y = 0, width = 240, height = 226 },
                    new { id = "wallpaper-amount-100", tileIds = new[] { secondId }, cards = Array.Empty<object>(), x = 250, y = 0, width = 240, height = 226 }
                }
            });
            var action = control.Value.GetProperty("action").GetString()!;
            writes.Add(action);
            return JsonSerializer.SerializeToElement(new { ok = true, revision = ++revision, committed = true });
        }

        using var wallpaper = new WallpaperOverlayState(directory, _ => { });
        JsonElement Overlay(long value) => JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1,
            revision = value,
            canvasWidth = 1920,
            canvasHeight = 1080,
            tiles = new[]
            {
                new { id = firstId, imageKey = (string?)null, imageUrl = (string?)null, groupKey = "wallpaper-amount-33", amount = 33, displayKind = "donation", actorName = "A", layout = (object?)null },
                new { id = secondId, imageKey = (string?)null, imageUrl = (string?)null, groupKey = "wallpaper-amount-100", amount = 100, displayKind = "donation", actorName = "B", layout = (object?)null }
            }
        });
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, revision, false, Overlay(revision)), CancellationToken.None);
        using var editor = new WallpaperEditorCoordinator(() => true, (control, token) => Task.FromResult(Remote(control)), () => 1, wallpaper, directory, _ => { }, new EditorTestClock(), false);
        await editor.GetStateAsync(CancellationToken.None);

        var merged = await editor.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-merge-rules",
            expectedRevision = revision,
            mergeRules = new[] { new { min = 1, max = 100 } }
        }), CancellationToken.None);
        Equal("", string.Join(",", writes), "merge rules stay local and do not call the server");
        Equal("wallpaper-merge-1-100", merged.GetProperty("groups")[0].GetProperty("id").GetString(), "local merge rules regroup immediately");
        Equal(1, merged.GetProperty("merge").GetProperty("savedRules").GetArrayLength(), "saved merge rule remains visible when the settings window reopens");
        Equal(session, merged.GetProperty("selectedSessionIds")[0].GetString(), "local settings preserve the selected broadcast");
        Equal(2, merged.GetProperty("settingsProtocol").GetInt32(), "size editing remains available after merge save");
        Equal(2, merged.GetProperty("visibility").GetProperty("visibleKeys").GetArrayLength(), "local settings preserve visibility metadata");
        using (var local = JsonDocument.Parse(wallpaper.SnapshotBytes()))
        {
            Equal("wallpaper-merge-1-100", local.RootElement.GetProperty("tiles")[0].GetProperty("groupKey").GetString(), "OBS snapshot receives local merge rules");
            Equal("wallpaper-merge-1-100", local.RootElement.GetProperty("tiles")[1].GetProperty("groupKey").GetString(), "all matching cards move into the local merged group");
        }

        var sized = await editor.ApplyAsync(JsonSerializer.SerializeToElement(new
        {
            action = "save-size-rules",
            expectedRevision = revision,
            sizeRules = new[] { new { min = 1, max = 100, width = 360 } },
            layoutSaveProtocol = 3,
            layoutTiles = new[] { new { id = firstId, x = 20, y = 30, width = 360, height = 226, columns = 2, rows = 1, nextSide = "right", layer = 1 } }
        }), CancellationToken.None);
        Equal("", string.Join(",", writes), "size rules stay local and do not call the server");
        Equal(360, sized.GetProperty("size").GetProperty("savedRules")[0].GetProperty("width").GetInt32(), "local size rule is visible in the editor");
        True(wallpaper.PendingLayout() is { AcknowledgedRevision: null }, "size save can still queue final layout backup separately");

        revision = 12;
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, revision, false, Overlay(revision)), CancellationToken.None);
        using (var afterRefresh = JsonDocument.Parse(wallpaper.SnapshotBytes()))
        {
            Equal("wallpaper-merge-1-100", afterRefresh.RootElement.GetProperty("tiles")[0].GetProperty("groupKey").GetString(), "server refresh preserves local merge rules");
            Equal(360, afterRefresh.RootElement.GetProperty("sizeRanges")[0].GetProperty("width").GetInt32(), "server refresh preserves local size rules");
        }

        var refreshed = await editor.RefreshAsync(CancellationToken.None);
        Equal(1, refreshed.GetProperty("merge").GetProperty("savedRules").GetArrayLength(), "old server merge rules cannot replace the local rules in the editor");
        Equal(360, refreshed.GetProperty("size").GetProperty("savedRules")[0].GetProperty("width").GetInt32(), "old server size rules cannot replace the local rules in the editor");

        await editor.DrainAsync();
        using var restartedState = new WallpaperOverlayState(directory, _ => { });
        using var restartedEditor = new WallpaperEditorCoordinator(() => false,
            (_, _) => throw new Exception("offline restart must not require the server"), () => 1,
            restartedState, directory, _ => { }, new EditorTestClock(), false);
        var restored = await restartedEditor.GetStateAsync(CancellationToken.None);
        Equal(1, restored.GetProperty("merge").GetProperty("savedRules").GetArrayLength(), "restart retains the merge settings UI");
        Equal(session, restored.GetProperty("selectedSessionIds")[0].GetString(), "offline restart retains selected broadcast");
        await restartedEditor.DrainAsync();
    }
}
