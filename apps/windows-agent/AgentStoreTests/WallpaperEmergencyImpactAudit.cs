using System.Net;
using System.Text.Json;

namespace HurogiCollector;

internal static partial class Program
{
    // Opt-in diagnostic, not a passing regression test: records current risks.
    // Uses temporary storage and fake HTTP only; never touches installed Agent.
    private static async Task AuditEmergencyWallpaperImpactAsync(string root)
    {
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlCIAAAAASUVORK5CYII=");
        JsonElement Snapshot() => JsonSerializer.SerializeToElement(new {
            schemaVersion = 1, revision = 10, canvasWidth = 1920, canvasHeight = 1080,
            tiles = new[] { "slow", "healthy" }.Select((key, index) => new {
                id = $"00000000-0000-4000-8000-{index + 1:D12}", imageKey = key,
                imageUrl = $"https://stimg.sooplive.com/{key}.png",
                groupKey = "donation:33", amount = 33, actorName = "fixture"
            })
        });
        var logs = new List<string>();
        var failureHandler = new ScriptedWallpaperHandler(uri => uri.AbsolutePath.Contains("slow")
            ? new HttpResponseMessage(HttpStatusCode.NotFound)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(png) });
        using (var state = new WallpaperOverlayState(Path.Combine(root, "repeat-failure"), logs.Add, failureHandler))
        {
            var displayVersions = new HashSet<string>();
            for (var attempt = 0; attempt < 3; attempt++)
            {
                await state.ApplyAsync(new VNextWallpaperSync(true, 10, false, Snapshot()), CancellationToken.None);
                using var value = JsonDocument.Parse(state.SnapshotBytes());
                displayVersions.Add(value.RootElement.GetProperty("displayRevision").GetString()!);
            }
            Console.WriteLine("REPEATED_FAILURE_AUDIT=" + JsonSerializer.Serialize(new {
                identicalSnapshots = 3, httpRequests = failureHandler.Requests.Count,
                distinctDisplayRevisions = displayVersions.Count, logEntries = logs.Count,
                acknowledgedRevision = state.Revision, hasPendingAssets = state.HasPendingAssets
            }));
        }

        using var blockedBody = new AuditBlockedImageStream(png);
        var slowHandler = new ScriptedWallpaperHandler(uri => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = uri.AbsolutePath.Contains("slow") ? new StreamContent(blockedBody) : new ByteArrayContent(png)
        });
        using var stalled = new WallpaperOverlayState(Path.Combine(root, "slow-body"), _ => { }, slowHandler);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(23));
        var apply = stalled.ApplyAsync(new VNextWallpaperSync(true, 10, false, Snapshot()), stop.Token);
        await blockedBody.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(TimeSpan.FromSeconds(16));
        using var before = JsonDocument.Parse(stalled.SnapshotBytes());
        Console.WriteLine("SLOW_BODY_AUDIT=" + JsonSerializer.Serialize(new {
            secondsAfterHeaders = 16, applyStillPending = !apply.IsCompleted,
            imageRequestsStarted = slowHandler.Requests.Count,
            visibleCards = before.RootElement.GetProperty("tiles").GetArrayLength()
        }));
        blockedBody.Release.TrySetResult(true);
        await apply.WaitAsync(TimeSpan.FromSeconds(3));
        using var after = JsonDocument.Parse(stalled.SnapshotBytes());
        Console.WriteLine("SLOW_BODY_RELEASED=" + JsonSerializer.Serialize(new {
            visibleCards = after.RootElement.GetProperty("tiles").GetArrayLength(),
            imageRequestsStarted = slowHandler.Requests.Count
        }));
    }

    private sealed class AuditBlockedImageStream(byte[] bytes) : Stream
    {
        internal TaskCompletionSource<bool> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<bool> Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int offset;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.Length;
        public override long Position { get => offset; set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Started.TrySetResult(true);
            await Release.Task.WaitAsync(cancellationToken);
            var count = Math.Min(buffer.Length, bytes.Length - offset);
            bytes.AsMemory(offset, count).CopyTo(buffer);
            offset += count;
            return count;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
