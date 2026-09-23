namespace HurogiCollector;

internal enum VNextActivityAlertState
{
    None,
    Blocked,
    NeedsReview,
    RecoveryDelayed
}

internal sealed record VNextActivityNotification(
    int Blocked,
    int NeedsReview,
    int RecoveryDelayed,
    int Recovered)
{
    public long SessionEpoch { get; init; }
    public int Total => Blocked + NeedsReview + RecoveryDelayed + Recovered;

    public string Summary()
    {
        var parts = new List<string>(4);
        if (Blocked > 0) parts.Add($"차단 {Blocked:N0}건");
        if (NeedsReview > 0) parts.Add($"확인 필요 {NeedsReview:N0}건");
        if (RecoveryDelayed > 0) parts.Add($"복구 지연 {RecoveryDelayed:N0}건");
        if (Recovered > 0) parts.Add($"복구 {Recovered:N0}건");
        return string.Join(" · ", parts);
    }
}

internal sealed class VNextActivityTransitionTracker
{
    private const int MaximumRememberedFingerprints = 512;
    private readonly Dictionary<string, VNextActivityAlertState> _states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _notifiedFingerprints = new(StringComparer.Ordinal);
    private readonly Queue<(string Id, string Fingerprint)> _fingerprintOrder = new();
    private bool _hasBaseline;

    public void Reset()
    {
        _states.Clear();
        _notifiedFingerprints.Clear();
        _fingerprintOrder.Clear();
        _hasBaseline = false;
    }

    public VNextActivityNotification Apply(VNextActivityPage page, DateTimeOffset nowUtc)
    {
        var current = new Dictionary<string, VNextActivityAlertState>(StringComparer.Ordinal);
        foreach (var item in page.Items)
            current[item.Id] = Classify(item, nowUtc);

        if (!_hasBaseline)
        {
            foreach (var pair in current) _states[pair.Key] = pair.Value;
            _hasBaseline = true;
            return new VNextActivityNotification(0, 0, 0, 0);
        }

        var blocked = 0;
        var needsReview = 0;
        var recoveryDelayed = 0;
        var recovered = 0;
        foreach (var item in page.Items)
        {
            var next = current[item.Id];
            var hadPrevious = _states.TryGetValue(item.Id, out var previous);
            if (!hadPrevious || previous != next)
            {
                var fingerprint = $"{(int)next}:{item.UpdatedAt.UtcDateTime.Ticks}";
                var shouldNotify = !_notifiedFingerprints.TryGetValue(item.Id, out var priorFingerprint)
                    || !string.Equals(priorFingerprint, fingerprint, StringComparison.Ordinal);
                if (shouldNotify)
                {
                    switch (next)
                    {
                        case VNextActivityAlertState.Blocked: blocked++; break;
                        case VNextActivityAlertState.NeedsReview: needsReview++; break;
                        case VNextActivityAlertState.RecoveryDelayed: recoveryDelayed++; break;
                        case VNextActivityAlertState.None when hadPrevious
                            && previous != VNextActivityAlertState.None
                            && string.Equals(item.Status, "succeeded", StringComparison.Ordinal):
                            recovered++;
                            break;
                    }
                    if (next != VNextActivityAlertState.None || recovered > 0)
                        RememberFingerprint(item.Id, fingerprint);
                }
            }
            _states[item.Id] = next;
        }

        // A full 100-row page can be truncated. Never infer recovery from absence.
        // Even on an unsaturated page, disappearance only expires local tracking;
        // an explicit succeeded transition is required for a recovery notification.
        if (!page.Saturated)
        {
            foreach (var id in _states.Keys.Where(id => !current.ContainsKey(id)).ToArray())
                _states.Remove(id);
        }
        if (_states.Count > MaximumRememberedFingerprints)
        {
            foreach (var id in _states.Keys
                .Where(id => !current.ContainsKey(id))
                .Take(_states.Count - MaximumRememberedFingerprints)
                .ToArray())
                _states.Remove(id);
        }
        return new VNextActivityNotification(blocked, needsReview, recoveryDelayed, recovered);
    }

    internal static VNextActivityAlertState Classify(VNextActivityItem item, DateTimeOffset nowUtc)
    {
        if (string.Equals(item.Status, "running", StringComparison.Ordinal)
            && item.LeaseExpiresAt.HasValue
            && item.LeaseExpiresAt.Value <= nowUtc)
            return VNextActivityAlertState.RecoveryDelayed;
        if (string.Equals(item.Status, "retry_scheduled", StringComparison.Ordinal)
            && item.NextAttemptAt.HasValue
            && item.NextAttemptAt.Value <= nowUtc)
            return VNextActivityAlertState.RecoveryDelayed;
        if (string.Equals(item.ErrorDisposition, "blocked", StringComparison.Ordinal)
            || string.Equals(item.Status, "cancelled", StringComparison.Ordinal))
            return VNextActivityAlertState.Blocked;
        if (string.Equals(item.ErrorDisposition, "needs_review", StringComparison.Ordinal)
            || (string.Equals(item.Status, "failed", StringComparison.Ordinal)
                && !string.Equals(item.ErrorDisposition, "retrying", StringComparison.Ordinal)))
            return VNextActivityAlertState.NeedsReview;
        return VNextActivityAlertState.None;
    }

    private void RememberFingerprint(string id, string fingerprint)
    {
        _notifiedFingerprints[id] = fingerprint;
        _fingerprintOrder.Enqueue((id, fingerprint));
        while (_fingerprintOrder.Count > MaximumRememberedFingerprints)
        {
            var oldest = _fingerprintOrder.Dequeue();
            if (_notifiedFingerprints.TryGetValue(oldest.Id, out var current)
                && string.Equals(current, oldest.Fingerprint, StringComparison.Ordinal))
                _notifiedFingerprints.Remove(oldest.Id);
        }
    }
}

internal sealed class VNextActivityMonitor : IDisposable
{
    private readonly VNextDevelopmentClient _client;
    private readonly TimeSpan _interval;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly object _epochGate = new();
    private readonly VNextActivityTransitionTracker _tracker = new();
    private CancellationTokenSource _epochCancellation = new();
    private Task? _loop;
    private int _disposed;

    public VNextActivityMonitor(
        VNextDevelopmentClient client,
        TimeSpan? interval = null)
    {
        _client = client;
        _interval = interval ?? TimeSpan.FromSeconds(60);
        _client.SessionChanged += Client_SessionChanged;
    }

    public event EventHandler<VNextActivityNotification>? NotificationReady;

    public void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        _loop ??= Task.Run(() => RunAsync(_stop.Token));
        Wake();
    }

    public void Wake()
    {
        if (_stop.IsCancellationRequested || _wake.CurrentCount != 0) return;
        try { _wake.Release(); } catch { }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (_client.IsSignedIn) await PollOnceAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                // Session epoch changed while a request was in flight.
            }
            catch
            {
                // A failed poll never advances the baseline and never contains raw
                // response text in a user notification or local log.
            }

            try { await _wake.WaitAsync(_interval, cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private async Task PollOnceAsync(CancellationToken cancellationToken)
    {
        var epoch = _client.CaptureSessionEpoch();
        if (!_client.IsSessionEpochCurrent(epoch)) return;
        CancellationToken epochToken;
        lock (_epochGate) epochToken = _epochCancellation.Token;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, epochToken);
        var page = await _client.LoadActivityAsync(100, linked.Token);
        linked.Token.ThrowIfCancellationRequested();
        if (!_client.IsSessionEpochCurrent(epoch)) return;
        VNextActivityNotification notification;
        lock (_epochGate)
        {
            linked.Token.ThrowIfCancellationRequested();
            if (!_client.IsSessionEpochCurrent(epoch)) return;
            notification = _tracker.Apply(page, DateTimeOffset.UtcNow) with { SessionEpoch = epoch };
        }
        if (notification.Total == 0) return;
        linked.Token.ThrowIfCancellationRequested();
        if (!_client.IsSessionEpochCurrent(epoch)) return;
        try { NotificationReady?.Invoke(this, notification); } catch { }
    }

    private void Client_SessionChanged(object? sender, EventArgs e)
    {
        lock (_epochGate)
        {
            if (Volatile.Read(ref _disposed) != 0) return;
            try { _epochCancellation.Cancel(); } catch { }
            _epochCancellation.Dispose();
            _epochCancellation = new CancellationTokenSource();
            _tracker.Reset();
        }
        Wake();
    }

    public async Task StopAsync()
    {
        try { _stop.Cancel(); } catch { }
        Wake();
        var loop = _loop;
        if (loop is null) return;
        try { await loop.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false); } catch { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _client.SessionChanged -= Client_SessionChanged;
        try { _stop.Cancel(); } catch { }
        lock (_epochGate)
        {
            try { _epochCancellation.Cancel(); } catch { }
            _epochCancellation.Dispose();
        }
        _wake.Dispose();
        _stop.Dispose();
    }
}
