using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

internal static partial class Program
{
    private sealed class EditorTestClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-09-05T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => _now;
        internal void Advance(int seconds) => _now = _now.AddSeconds(seconds);
    }

    private static async Task WallpaperEditorBackupTestsAsync(string root)
    {
        var path = Path.Combine(root, "editor-backup-coordinator");
        Directory.CreateDirectory(path);
        var id = Guid.NewGuid().ToString("D");
        var sessionA = Guid.NewGuid().ToString("D");
        var sessionB = Guid.NewGuid().ToString("D");
        JsonElement Overlay(long revision, int? x = null, bool donation = false) => JsonSerializer.SerializeToElement(new
        {
            schemaVersion = 1, revision, canvasWidth = 1920, canvasHeight = 1080,
            tiles = (donation ? new[] { id, "22222222-2222-4222-8222-222222222222" } : new[] { id }).Select(tileId => new
            {
                id = tileId, imageKey = (string?)null, imageUrl = (string?)null,
                groupKey = "wallpaper-amount-100", amount = 100, actorName = "fixture",
                layout = x is null ? null : new { x = x.Value, y = 80, width = 240, height = 226, columns = 2, rows = 3, nextSide = "right", layer = 1 }
            })
        });
        JsonElement Layout(int x) => JsonSerializer.SerializeToElement(new
        {
            action = "save-layout", expectedRevision = 9,
            tiles = new[] { new { id, x, y = 80, width = 240, height = 226, columns = 2, rows = 3, nextSide = "right", layer = 1 } }
        });
        var backendX = 0;
        JsonElement Editor(long revision, string session) => JsonSerializer.SerializeToElement(new
        {
            revision, selectedSessionIds = new[] { session }, displayKey = session,
            groups = new[] { new { id = "wallpaper-amount-100", tileIds = new[] { id }, cards = Array.Empty<object>(), x = backendX, y = 80, width = 240, height = 226, layoutColumns = 2, layoutRows = 3, nextSide = "right", layer = 1 } }
        });
        var clock = new EditorTestClock();
        using var wallpaper = new WallpaperOverlayState(path, _ => { });
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, Overlay(9)), CancellationToken.None);
        var signedIn = true;
        var gets = 0;
        var saves = new List<int>();
        var order = new List<string>();
        var backendRevision = 9L;
        var backendSession = sessionA;
        TaskCompletionSource? backupEntered = null;
        TaskCompletionSource? releaseBackup = null;
        TaskCompletionSource? selectionEntered = null;
        TaskCompletionSource? releaseSelection = null;
        var failSelection = false;
        var failBackup = false;
        async Task<JsonElement> Remote(JsonElement? control, CancellationToken token)
        {
            if (control is null)
            {
                Interlocked.Increment(ref gets);
                return Editor(backendRevision, backendSession);
            }
            var action = control.Value.GetProperty("action").GetString()!;
            order.Add(action);
            if (action == "save-layout")
            {
                saves.Add(control.Value.GetProperty("tiles")[0].GetProperty("x").GetInt32());
                backupEntered?.TrySetResult();
                if (releaseBackup is not null) await releaseBackup.Task.WaitAsync(token);
                if (failBackup) throw new IOException("fixture offline");
                backendX = control.Value.GetProperty("tiles")[0].GetProperty("x").GetInt32();
            }
            else if (action == "select-sessions")
            {
                selectionEntered?.TrySetResult();
                if (releaseSelection is not null) await releaseSelection.Task.WaitAsync(token);
                if (failSelection) throw new IOException("fixture selection unavailable");
                backendSession = control.Value.GetProperty("sessionIds")[0].GetString()!;
            }
            return Editor(++backendRevision, backendSession);
        }
        using var coordinator = new WallpaperEditorCoordinator(() => signedIn, Remote, () => 1,
            wallpaper, path, _ => { }, clock);
        await coordinator.GetStateAsync(CancellationToken.None);
        Equal(1, gets, "editor downloads initial state once");
        var cacheFile = Path.Combine(path, "wallpaper-editor-cache-v1.json");
        var writeTime = File.GetLastWriteTimeUtc(cacheFile);
        for (var i = 0; i < 240; i++) await coordinator.GetStateAsync(CancellationToken.None);
        Equal(1, gets, "240 local editor polls do not produce 240 server reads");
        Equal(writeTime, File.GetLastWriteTimeUtc(cacheFile), "unchanged local reads do not rewrite the cache");

        for (var i = 0; i < 20; i++)
        {
            await coordinator.ApplyAsync(Layout(100 + i), CancellationToken.None);
            await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        }
        Equal(0, saves.Count, "editing and donation wake hints cannot bypass the backup interval");
        using (var local = JsonDocument.Parse(wallpaper.SnapshotBytes()))
            Equal(119, local.RootElement.GetProperty("tiles")[0].GetProperty("layout").GetProperty("x").GetInt32(),
                "every edit is already in the OBS snapshot before any server backup");
        clock.Advance(60);
        backupEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        releaseBackup = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var backup = coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        await backupEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Equal(119, saves.Single(), "twenty edits coalesce into the last placement");
        await coordinator.ApplyAsync(Layout(333), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
        await coordinator.GetStateAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
        True(await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 10, false, Overlay(10, donation: true)), CancellationToken.None),
            "new donations apply while the server backup is stalled");
        using (var incoming = JsonDocument.Parse(wallpaper.SnapshotBytes()))
        {
            Equal(2, incoming.RootElement.GetProperty("tiles").GetArrayLength(), "new donation is not delayed by backup");
            Equal(333, incoming.RootElement.GetProperty("tiles")[0].GetProperty("layout").GetProperty("x").GetInt32(),
                "new donation snapshot preserves the latest local placement");
        }
        backendRevision = 10;
        var beforeDonationReads = gets;
        coordinator.NotifyWallpaperChanged();
        await coordinator.GetStateAsync(CancellationToken.None);
        var donationRefreshDeadline = DateTime.UtcNow.AddSeconds(2);
        while (gets == beforeDonationReads && DateTime.UtcNow < donationRefreshDeadline) await Task.Delay(10);
        True(gets > beforeDonationReads, "a new-donation editor refresh does not wait for the stalled backup");
        releaseBackup.TrySetResult();
        await backup;
        True(wallpaper.PendingLayout()?.AcknowledgedRevision is null, "an old ACK cannot clear a newer edit");
        var cached = await coordinator.GetStateAsync(CancellationToken.None);
        Equal(sessionA, cached.GetProperty("selectedSessionIds")[0].GetString(), "backup ACK cannot replace selection");
        Equal(333, cached.GetProperty("groups")[0].GetProperty("x").GetInt32(), "backup ACK cannot replace newer cached layout");

        backupEntered = null; releaseBackup = null;
        clock.Advance(60);
        await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        var acknowledged = wallpaper.PendingLayout()!;
        True(acknowledged.AcknowledgedRevision is not null, "successful backup keeps a versioned override until snapshot confirmation");
        using (var restarted = new WallpaperOverlayState(path, _ => { }))
            Equal(acknowledged.AcknowledgedRevision, restarted.PendingLayout()?.AcknowledgedRevision,
                "the backup ACK fence survives a restart");
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 10, false, Overlay(10)), CancellationToken.None);
        using (var late = JsonDocument.Parse(wallpaper.SnapshotBytes()))
            Equal(333, late.RootElement.GetProperty("tiles")[0].GetProperty("layout").GetProperty("x").GetInt32(),
                "a late pre-ACK snapshot cannot revert acknowledged local placement");
        await wallpaper.ApplyAsync(new VNextWallpaperSync(true, acknowledged.AcknowledgedRevision!.Value, false,
            Overlay(acknowledged.AcknowledgedRevision.Value, 333)), CancellationToken.None);
        True(wallpaper.PendingLayout() is null, "matching server snapshot retires the acknowledged override");
        False(await wallpaper.ApplyAsync(new VNextWallpaperSync(true, 9, false, Overlay(9)), CancellationToken.None),
            "older server revisions cannot replace the current local snapshot");

        await coordinator.ApplyAsync(Layout(400), CancellationToken.None);
        order.Clear();
        var selected = await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        { action = "select-sessions", sessionIds = new[] { sessionB } }), CancellationToken.None);
        Equal("save-layout,select-sessions", string.Join(',', order), "switching sessions preserves pending edits before changing the source set");
        Equal(sessionB, selected.GetProperty("selectedSessionIds")[0].GetString(), "selection response remains authoritative for explicit selection");

        selectionEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        releaseSelection = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var slowSelection = coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        { action = "select-sessions", sessionIds = new[] { sessionA } }), CancellationToken.None);
        await selectionEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        for (var i = 0; i < 20; i++)
        {
            var readable = await coordinator.GetStateAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1));
            Equal(sessionB, readable.GetProperty("selectedSessionIds")[0].GetString(),
                "slow selection does not block local reads or pretend the new selection succeeded");
        }
        using (var cancelledEdit = new CancellationTokenSource())
        {
            var edit = coordinator.ApplyAsync(Layout(499), cancelledEdit.Token);
            False(edit.IsCompleted, "selection/layout write order is unchanged during a transition");
            cancelledEdit.Cancel();
            await ThrowsAsync<OperationCanceledException>(async () => await edit,
                "cancelled queued edit cannot leak into the next broadcast selection");
        }
        releaseSelection.TrySetResult();
        await slowSelection.WaitAsync(TimeSpan.FromSeconds(2));
        selectionEntered = null; releaseSelection = null;
        failSelection = true;
        await ThrowsAsync<IOException>(async () => await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
        { action = "select-sessions", sessionIds = new[] { sessionB } }), CancellationToken.None),
            "failed selection still reports failure, not success");
        Equal(sessionA, (await coordinator.GetStateAsync(CancellationToken.None)).GetProperty("selectedSessionIds")[0].GetString(),
            "failed selection preserves the last confirmed state");
        failSelection = false;
        for (var i = 0; i < 20; i++)
        {
            var expected = i % 2 == 0 ? sessionB : sessionA;
            var changed = await coordinator.ApplyAsync(JsonSerializer.SerializeToElement(new
            { action = "select-sessions", sessionIds = new[] { expected } }), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
            Equal(expected, changed.GetProperty("selectedSessionIds")[0].GetString(), "repeated selection recovers after cancellation/failure");
        }

        signedIn = false;
        await coordinator.ApplyAsync(Layout(500), CancellationToken.None);
        var beforeOffline = saves.Count;
        clock.Advance(61);
        await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        Equal(beforeOffline, saves.Count, "offline editing does not attempt authenticated backups");
        using (var restarted = new WallpaperOverlayState(path, _ => { }))
            Equal(500, restarted.PendingLayout()!.Tiles[0].GetProperty("x").GetInt32(), "offline edits survive restart");
        signedIn = true; failBackup = true;
        await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        var failedAttempts = saves.Count;
        for (var i = 0; i < 50; i++) await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        Equal(failedAttempts, saves.Count, "failed backup wake storms are rate limited");
        True(wallpaper.PendingLayout()?.AcknowledgedRevision is null, "failed backup leaves local edits queued");
        failBackup = false; clock.Advance(60);
        await coordinator.TrySynchronizePendingAsync(CancellationToken.None);
        True(wallpaper.PendingLayout()?.AcknowledgedRevision is not null, "reconnection backs up the latest edit");
        await coordinator.RefreshAsync(CancellationToken.None);
        var beforeBurst = gets;
        for (var i = 0; i < 100; i++)
        {
            coordinator.NotifyWallpaperChanged();
            await coordinator.GetStateAsync(CancellationToken.None);
        }
        Equal(beforeBurst, gets, "a burst of donation hints cannot increase full-state traffic above the old 15-second polling rate");
        Console.WriteLine("EDITOR_BACKUP_SIMULATION: 240 local reads => 1 initial server read; 20 edits => 1 backup; stalled backup did not block edit/donation.");
    }
}
