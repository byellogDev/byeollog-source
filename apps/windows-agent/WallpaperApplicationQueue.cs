namespace HurogiCollector;

// One active application and one latest pending snapshot, never an unbounded queue.
// Newer donations cancel old image I/O, not the durable layout or server cursor.
internal sealed class WallpaperApplicationQueue : IDisposable
{
    private sealed record Item(VNextWallpaperSync Sync, long Generation, CancellationToken Stop);
    private readonly object _gate = new();
    private readonly Func<VNextWallpaperSync, long, CancellationToken, Task> _apply;
    private Item? _pending, _active;
    private CancellationTokenSource? _activeStop;
    private bool _running, _disposed;
    private TaskCompletionSource<bool> _idle = Completed();
    internal WallpaperApplicationQueue(Func<VNextWallpaperSync, long, CancellationToken, Task> apply) => _apply = apply;
    internal bool HasPending { get { lock (_gate) return _pending is not null; } }
    internal Task WhenIdle { get { lock (_gate) return _idle.Task; } }

    internal void Enqueue(VNextWallpaperSync sync, long generation, CancellationToken stop)
    {
        lock (_gate)
        {
            if (_disposed || stop.IsCancellationRequested) return;
            var latest = _pending ?? _active;
            if (latest is not null && (sync.Revision < latest.Sync.Revision
                || (sync.Revision == latest.Sync.Revision && generation <= latest.Generation))) return;
            _pending = new Item(sync, generation, stop);
            if (_active is not null && sync.Revision > _active.Sync.Revision) _activeStop?.Cancel();
            if (_running) return;
            _running = true;
            _idle = new(TaskCreationOptions.RunContinuationsAsynchronously);
            _ = Task.Run(PumpAsync);
        }
    }

    private async Task PumpAsync()
    {
        Exception? failure = null;
        while (true)
        {
            Item item; CancellationTokenSource stop;
            lock (_gate)
            {
                if (_disposed || _pending is null)
                {
                    _running = false;
                    if (failure is null) _idle.TrySetResult(true); else _idle.TrySetException(failure);
                    return;
                }
                item = _pending; _pending = null; _active = item;
                stop = _activeStop = CancellationTokenSource.CreateLinkedTokenSource(item.Stop);
            }
            try { await _apply(item.Sync, item.Generation, stop.Token); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
            catch (Exception ex) { failure = ex; }
            finally
            {
                lock (_gate) { _active = null; _activeStop = null; }
                stop.Dispose();
            }
        }
    }

    public void Dispose()
    {
        lock (_gate) { _disposed = true; _pending = null; _activeStop?.Cancel(); }
    }
    private static TaskCompletionSource<bool> Completed()
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        completion.SetResult(true); return completion;
    }
}
