using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

/// <summary>
/// Owns the local wallpaper editor boundary. Layout changes are committed to
/// the localhost overlay first, survive process restarts, and are uploaded
/// only as an eventual synchronization step.
/// </summary>
internal sealed class WallpaperEditorCoordinator : IDisposable
{
    private const int MaximumCacheBytes = 4 * 1024 * 1024;
    private readonly Func<bool> _isSignedIn;
    private readonly Func<JsonElement?, CancellationToken, Task<JsonElement>> _sendControl;
    private readonly Func<long> _sessionEpoch;
    private readonly TimeProvider _clock;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly WallpaperOverlayState _wallpaper;
    private readonly string _cachePath;
    private readonly Action<string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    // Preserve the existing selection/layout transaction order without holding
    // the local read/cache gate across network I/O.
    private readonly SemaphoreSlim _layoutGate = new(1, 1);
    // Writes are ordered. Reads use their own lane so a slow backup cannot
    // delay the editor's new-donation update; explicit controls fence late reads.
    private readonly SemaphoreSlim _remoteGate = new(1, 1);
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private JsonElement? _memoryCache;
    private byte[]? _cacheBytes;
    private bool _cacheLoaded;
    private int _refreshScheduled, _backupScheduled;
    private long _refreshRequested, _refreshCompleted;
    private long _controlGeneration;
    private int _controlInFlight;
    private DateTimeOffset _nextRemoteAttemptAtUtc = DateTimeOffset.MinValue;
    private DateTimeOffset _nextBackupAtUtc = DateTimeOffset.MinValue;
    private DateTimeOffset _lastRemoteRefreshAtUtc = DateTimeOffset.MinValue;
    internal static readonly TimeSpan RemoteRecoveryInterval = TimeSpan.FromMinutes(10);
    // Keep editor full-state reads at/below the old polling rate during a burst.
    // This limit does NOT apply to the direct donation/OBS snapshot transport.
    internal static readonly TimeSpan MinimumEventRefreshInterval = TimeSpan.FromSeconds(15);
    internal static readonly TimeSpan BackupInterval = TimeSpan.FromMinutes(1);
    internal event Action? StateChanged;
    internal WallpaperBaekdusan Baekdusan { get; }

    internal WallpaperEditorCoordinator(
        Func<bool> isSignedIn,
        Func<JsonElement?, CancellationToken, Task<JsonElement>> sendControl,
        Func<long> sessionEpoch,
        WallpaperOverlayState wallpaper,
        string rootPath,
        Action<string> log,
        TimeProvider? clock = null, bool scheduleInitialBackup = true)
    {
        _isSignedIn = isSignedIn;
        _sendControl = sendControl;
        _sessionEpoch = sessionEpoch;
        _clock = clock ?? TimeProvider.System;
        _wallpaper = wallpaper;
        _cachePath = Path.Combine(rootPath, "wallpaper-editor-cache-v1.json");
        _log = log;
        Baekdusan = new WallpaperBaekdusan(rootPath, _isSignedIn, _sendControl, () => StateChanged?.Invoke());
        _wallpaper.BaekdusanView = () => Baekdusan.View;
        if (scheduleInitialBackup) ScheduleBackup();
    }

    internal async Task<JsonElement> GetStateAsync(CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        cancellationToken = lifetime.Token;
        cancellationToken.ThrowIfCancellationRequested();
        JsonElement? cached;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            cached = LoadCache();
            var now = _clock.GetUtcNow();
            if (cached is not null)
            {
                if (_isSignedIn() && now >= _nextRemoteAttemptAtUtc
                    && (now - _lastRemoteRefreshAtUtc >= RemoteRecoveryInterval
                        || ReadRevision(cached.Value) < _wallpaper.Revision
                        || Volatile.Read(ref _refreshRequested) > Volatile.Read(ref _refreshCompleted)))
                    ScheduleRefresh();
                ScheduleBackup();
                return Baekdusan.Decorate(cached.Value);
            }
        }
        finally { _gate.Release(); }
        // Only first use without any local state may wait for the initial download.
        await RefreshRemoteAsync(cancellationToken);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            cached = LoadCache();
            if (cached is not null) return Baekdusan.Decorate(cached.Value);
            var fallback = BuildFallbackState();
            await SaveCacheAsync(fallback, cancellationToken);
            return Baekdusan.Decorate(fallback);
        }
        finally { _gate.Release(); }
    }

    internal void NotifyWallpaperChanged()
    {
        Baekdusan.Notify();
        Interlocked.Increment(ref _refreshRequested);
        StateChanged?.Invoke();
    }

    internal async Task<JsonElement> RefreshAsync(CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        cancellationToken = lifetime.Token;
        cancellationToken.ThrowIfCancellationRequested();
        _nextRemoteAttemptAtUtc = DateTimeOffset.MinValue;
        await RefreshRemoteAsync(cancellationToken);
        return await GetStateAsync(cancellationToken);
    }

    private void ScheduleRefresh()
    {
        if (_lifetime.IsCancellationRequested || Interlocked.CompareExchange(ref _refreshScheduled, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try { await RefreshRemoteAsync(_lifetime.Token); }
            catch (OperationCanceledException) { }
            finally { Interlocked.Exchange(ref _refreshScheduled, 0); }
        });
    }

    private async Task RefreshRemoteAsync(CancellationToken cancellationToken)
    {
        if (!_isSignedIn() || _clock.GetUtcNow() < _nextRemoteAttemptAtUtc) return;
        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            if (Volatile.Read(ref _controlInFlight) != 0) return;
            var generation = Volatile.Read(ref _refreshRequested);
            var controlGeneration = Volatile.Read(ref _controlGeneration);
            var epoch = _sessionEpoch();
            var remote = await _sendControl(null, cancellationToken);
            if (!_isSignedIn() || epoch != _sessionEpoch()) return;
            await _gate.WaitAsync(cancellationToken);
            try
            {
                if (controlGeneration != Volatile.Read(ref _controlGeneration)
                    || Volatile.Read(ref _controlInFlight) != 0) return;
                var cached = LoadCache();
                if (ReadRevision(remote) >= _wallpaper.Revision
                    && (cached is null || ReadRevision(remote) >= ReadRevision(cached.Value)))
                {
                    await Baekdusan.SelectAsync(remote, cancellationToken);
                    await SaveCacheAsync(Localize(remote), cancellationToken);
                    _lastRemoteRefreshAtUtc = _clock.GetUtcNow();
                    Volatile.Write(ref _refreshCompleted, generation);
                }
                _nextRemoteAttemptAtUtc = _clock.GetUtcNow() + MinimumEventRefreshInterval;
            }
            finally { _gate.Release(); }
            StateChanged?.Invoke();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _nextRemoteAttemptAtUtc = _clock.GetUtcNow().AddSeconds(15);
            _log("풍벽지 편집 정보 갱신 보류 · 로컬 편집 유지 · type=" + ex.GetType().Name);
        }
        finally { _refreshGate.Release(); }
    }

    internal async Task<JsonElement> ApplyAsync(JsonElement control, CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        cancellationToken = lifetime.Token;
        cancellationToken.ThrowIfCancellationRequested();
        if (control.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("풍벽지 요청이 올바르지 않습니다.");
        var action = control.TryGetProperty("action", out var actionValue)
            ? actionValue.GetString() : null;
        if (action?.StartsWith("baekdusan-", StringComparison.Ordinal) == true)
        {
            var result = await Baekdusan.ControlAsync(control, cancellationToken);
            return action == "baekdusan-log" ? result : await GetStateAsync(cancellationToken);
        }
        if (action is "save-merge-rules" or "save-size-rules")
        {
            await _layoutGate.WaitAsync(cancellationToken);
            try
            {
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    var cachedBeforeSettings = LoadCache() ?? BuildFallbackState();
                    if (action == "save-merge-rules")
                    {
                        var mergeRules = control.TryGetProperty("mergeRules", out var values) ? values : default;
                        await _wallpaper.ApplyLocalDisplayRulesAsync(mergeRules, null, cancellationToken);
                    }
                    else
                    {
                        var sizeRules = control.TryGetProperty("sizeRules", out var values) ? values : default;
                        if (control.TryGetProperty("layoutTiles", out var validateTiles))
                            WallpaperOverlayState.NormalizeLayoutTiles(validateTiles);
                        await _wallpaper.ApplyLocalDisplayRulesAsync(null, sizeRules, cancellationToken);
                        if (control.TryGetProperty("layoutTiles", out var layoutTiles))
                        {
                            var pending = _wallpaper.PendingLayout();
                            var cachedBeforeLayout = cachedBeforeSettings;
                            var baseTiles = pending is { AcknowledgedRevision: null }
                                ? pending.BaseTiles
                                : CaptureLayoutFromEditorState(cachedBeforeLayout, layoutTiles);
                            var baseRevision = pending is { AcknowledgedRevision: null }
                                ? pending.BaseRevision
                                : _wallpaper.Revision;
                            await _wallpaper.ApplyLocalLayoutAsync(baseRevision, layoutTiles, baseTiles, cancellationToken);
                        }
                    }
                    var updated = BuildFallbackState(cachedBeforeSettings);
                    await SaveCacheAsync(updated, cancellationToken);
                    ScheduleBackup();
                    return Baekdusan.Decorate(updated);
                }
                finally { _gate.Release(); }
            }
            finally { _layoutGate.Release(); }
        }
        if (!string.Equals(action, "save-layout", StringComparison.Ordinal))
        {
            if (!_isSignedIn())
                throw new InvalidOperationException("이 설정은 인터넷 연결 후 변경할 수 있습니다.");
            await _remoteGate.WaitAsync(cancellationToken);
            Interlocked.Increment(ref _controlGeneration);
            Volatile.Write(ref _controlInFlight, 1);
            try
            {
                await _layoutGate.WaitAsync(cancellationToken);
                try
                {
                    JsonElement? settingsBaseline = null;
                    if (action is "save-visibility" or "save-merge-rules" or "save-size-rules")
                    {
                        await _gate.WaitAsync(cancellationToken);
                        try { settingsBaseline = LoadCache(); }
                        finally { _gate.Release(); }
                    }
                    // Explicit selection/settings changes remain transactional with their
                    // source data. Flush edits before leaving the selected sessions.
                    await BackupCoreAsync(cancellationToken);
                    var epoch = _sessionEpoch();
                    if (settingsBaseline is not null
                        && control.TryGetProperty("expectedRevision", out var expected)
                        && expected.TryGetInt64(out var expectedRevision)
                        && expectedRevision == ReadRevision(settingsBaseline.Value))
                    {
                        // A layout backup or incoming donation advances the shared revision.
                        // Rebase only after proving the selected sessions and visibility have
                        // not changed. Never replay a stale full visibility list over another editor.
                        var current = await _sendControl(null, cancellationToken);
                        if (!_isSignedIn() || epoch != _sessionEpoch())
                            throw new OperationCanceledException("연결 계정이 변경되었습니다.");
                        if (SettingsSelectionMatches(action!, settingsBaseline.Value, current))
                        {
                            var rebased = JsonNode.Parse(control.GetRawText())!.AsObject();
                            rebased["expectedRevision"] = ReadRevision(current);
                            control = JsonSerializer.SerializeToElement(rebased);
                        }
                    }
                    var requestedSelection = string.Equals(action, "select-sessions", StringComparison.Ordinal)
                        ? ReadSessionIds(control) : null;
                    if (requestedSelection is not null)
                        _log("풍벽지 방송 회차 선택 요청 · count=" + requestedSelection.Count);
                    var remote = await _sendControl(control, cancellationToken);
                    if (!_isSignedIn() || epoch != _sessionEpoch()) throw new OperationCanceledException("연결 계정이 변경되었습니다.");
                    if (remote.TryGetProperty("refreshPending", out var refreshPending)
                        && refreshPending.ValueKind == JsonValueKind.True)
                    {
                        // The transaction committed. Do not cache a receipt as a full
                        // snapshot or report the committed write as a failed save.
                        NotifyWallpaperChanged();
                        return remote;
                    }
                    if (requestedSelection is not null && !SelectionMatches(remote, requestedSelection))
                        throw new InvalidDataException("서버가 저장한 방송 회차 선택을 다시 확인하지 못했습니다.");
                    await _gate.WaitAsync(cancellationToken);
                    try
                    {
                        await Baekdusan.SelectAsync(remote, cancellationToken);
                        var localized = Localize(remote);
                        await SaveCacheAsync(localized, cancellationToken);
                        _lastRemoteRefreshAtUtc = _clock.GetUtcNow();
                        _nextRemoteAttemptAtUtc = _lastRemoteRefreshAtUtc + MinimumEventRefreshInterval;
                        if (action is "reset" or "auto-arrange" or "save-merge-rules" or "save-size-rules")
                        {
                            var pending = _wallpaper.PendingLayout();
                            if (pending?.AcknowledgedRevision is not null) await _wallpaper.ClearPendingLayoutAsync(pending.Generation, cancellationToken);
                            await SaveCacheAsync(Localize(remote), cancellationToken);
                            localized = LoadCache()!.Value;
                        }
                        if (requestedSelection is not null)
                            _log("풍벽지 방송 회차 선택 완료 · count=" + requestedSelection.Count
                                + " · revision=" + ReadRevision(remote));
                        return Baekdusan.Decorate(localized);
                    }
                    finally { _gate.Release(); }
                }
                finally { _layoutGate.Release(); }
            }
            finally
            {
                Interlocked.Increment(ref _controlGeneration);
                Volatile.Write(ref _controlInFlight, 0);
                _remoteGate.Release();
            }
        }

        var revision = control.TryGetProperty("expectedRevision", out var revisionValue)
            && revisionValue.TryGetInt64(out var parsedRevision) ? parsedRevision : -1;
        if (!control.TryGetProperty("tiles", out var tiles))
            throw new InvalidDataException("풍벽지 배치 정보가 없습니다.");
        await _layoutGate.WaitAsync(cancellationToken);
        try
        {
            await _gate.WaitAsync(cancellationToken);
            try
            {
                var cached = LoadCache() ?? BuildFallbackState();
                var pending = _wallpaper.PendingLayout();
                var wasPending = pending is { AcknowledgedRevision: null };
                var baseTiles = CaptureLayoutFromEditorState(cached, tiles);
                var baseRevision = revision;
                if (pending is { AcknowledgedRevision: null } unacknowledged)
                {
                    baseTiles = unacknowledged.BaseTiles;
                    baseRevision = unacknowledged.BaseRevision;
                }
                await _wallpaper.ApplyLocalLayoutAsync(baseRevision, tiles, baseTiles, cancellationToken);
                var updated = ApplyLayoutToEditorState(cached, tiles);
                await SaveCacheAsync(updated, cancellationToken);
                if (!wasPending) _nextBackupAtUtc = _clock.GetUtcNow() + BackupInterval;
                ScheduleBackup();
                return Baekdusan.Decorate(updated);
            }
            finally { _gate.Release(); }
        }
        finally { _layoutGate.Release(); }
    }

    internal async Task TrySynchronizePendingAsync(CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        cancellationToken = lifetime.Token;
        if (cancellationToken.IsCancellationRequested) return;
        if (!_isSignedIn()) return;
        if (!await _remoteGate.WaitAsync(0, cancellationToken)) return;
        try
        {
            await _gate.WaitAsync(cancellationToken);
            try
            {
                if (_clock.GetUtcNow() < _nextBackupAtUtc) return;
                _nextBackupAtUtc = _clock.GetUtcNow() + BackupInterval;
            }
            finally { _gate.Release(); }
            // No local gate is held while the backup traverses the network.
            await BackupCoreAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception ex) { _log("풍벽지 배치 백업 보류 · 로컬 편집 유지 · type=" + ex.GetType().Name); }
        finally { _remoteGate.Release(); }
    }

    private async Task BackupCoreAsync(CancellationToken cancellationToken)
    {
        var pending = _wallpaper.PendingLayout();
        if (pending is null || pending.AcknowledgedRevision is not null) return;
        var epoch = _sessionEpoch();
        // A new broadcast/reset can remove old tiles before this delayed backup.
        // Never send those IDs into the server's selected-session-only write RPC.
        using var snapshot = JsonDocument.Parse(_wallpaper.SnapshotBytes());
        var currentIds = snapshot.RootElement.GetProperty("tiles").EnumerateArray()
            .Select(tile => tile.GetProperty("id").GetString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var tiles = pending.Tiles.EnumerateArray()
            .Where(tile => currentIds.Contains(tile.GetProperty("id").GetString())).Select(tile => tile.Clone()).ToArray();
        if (tiles.Length == 0)
        {
            await _wallpaper.AcknowledgePendingLayoutAsync(pending.Generation, _wallpaper.Revision, cancellationToken);
            return;
        }
        var remote = await _sendControl(null, cancellationToken);
        if (!_isSignedIn() || epoch != _sessionEpoch()) return;
        if (!LayoutMatchesBase(remote, pending.BaseTiles))
        {
            _log("풍벽지 배치 백업 보류 · 서버 배치가 먼저 바뀜");
            await _gate.WaitAsync(cancellationToken);
            try { _nextBackupAtUtc = _clock.GetUtcNow() + BackupInterval; }
            finally { _gate.Release(); }
            return;
        }
        var control = JsonSerializer.SerializeToElement(new
        {
            action = "save-layout",
            responseMode = "receipt",
            layoutSaveProtocol = 3,
            expectedRevision = Math.Max(ReadRevision(remote), pending.BaseRevision),
            tiles
        });
        var response = await _sendControl(control, cancellationToken);
        if (!_isSignedIn() || epoch != _sessionEpoch()) return;
        var revision = ReadRevision(response);
        if (revision < 0) throw new InvalidDataException("풍벽지 백업 응답이 올바르지 않습니다.");
        // ACKs carry an old selection/full state. Never replace the editor cache
        // from a backup response, or clear a newer generation's pending edits.
        await _wallpaper.AcknowledgePendingLayoutAsync(pending.Generation, revision, cancellationToken, pending.Tiles);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (LoadCache() is { } cached)
            {
                var root = JsonNode.Parse(cached.GetRawText())!.AsObject();
                var baseline = new JsonObject { ["groups"] = (root["serverLayoutBase"] ?? root["groups"])?.DeepClone() };
                ApplyLayoutNode(baseline, pending.Tiles);
                root["serverLayoutBase"] = baseline["groups"]?.DeepClone();
                await SaveCacheAsync(JsonSerializer.SerializeToElement(root), cancellationToken);
            }
        }
        finally { _gate.Release(); }
        _log("풍벽지 배치 서버 백업 완료 · revision=" + revision);
    }

    private void ScheduleBackup()
    {
        var pending = _wallpaper.PendingLayout();
        if (pending is null || pending.AcknowledgedRevision is not null || _lifetime.IsCancellationRequested
            || Interlocked.CompareExchange(ref _backupScheduled, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                TimeSpan delay;
                await _gate.WaitAsync(_lifetime.Token);
                try { delay = _nextBackupAtUtc - _clock.GetUtcNow(); }
                finally { _gate.Release(); }
                // Re-evaluate the actual deadline when edits arrive while an older
                // timer exists; a fixed additional minute could double backup lag.
                await Task.Delay(delay > TimeSpan.Zero ? delay : TimeSpan.Zero, _lifetime.Token);
                await TrySynchronizePendingAsync(_lifetime.Token);
            }
            catch (OperationCanceledException) { }
            finally
            {
                if (!_lifetime.IsCancellationRequested)
                {
                    await _gate.WaitAsync(CancellationToken.None);
                    try
                    {
                        // Offline or a busy write lane must not cause a zero-delay loop.
                        if (_nextBackupAtUtc <= _clock.GetUtcNow()) _nextBackupAtUtc = _clock.GetUtcNow() + BackupInterval;
                    }
                    finally { _gate.Release(); }
                }
                Interlocked.Exchange(ref _backupScheduled, 0);
                if (!_lifetime.IsCancellationRequested) ScheduleBackup();
            }
        });
    }

    public void Dispose()
    {
        Baekdusan.Dispose();
        _lifetime.Cancel();
        StateChanged = null;
        // Active tasks own these primitives until cancellation has unwound.
    }

    internal async Task DrainAsync()
    {
        Dispose();
        await Baekdusan.DrainAsync();
        // Public operations link lifetime before entering any lane. No new operation
        // can enter after retirement; drain in the same order as explicit controls.
        foreach (var lane in new[] { _remoteGate, _refreshGate, _layoutGate, _gate })
        {
            await lane.WaitAsync();
            lane.Release();
        }
    }

    private static HashSet<string>? ReadSessionIds(JsonElement source, string property = "sessionIds")
    {
        if (!source.TryGetProperty(property, out var values) || values.ValueKind != JsonValueKind.Array)
            return null;
        return values.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()))
            .Select(value => value.GetString()!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private static bool SelectionMatches(JsonElement source, HashSet<string> expected)
    {
        if (!source.TryGetProperty("selectedSessionIds", out var values) || values.ValueKind != JsonValueKind.Array)
            return false;
        var actual = values.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()))
            .Select(value => value.GetString()!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return actual.SetEquals(expected);
    }

    private static long ReadRevision(JsonElement source)
        => source.TryGetProperty("revision", out var value) && value.TryGetInt64(out var revision)
            ? revision : -1;

    private static bool VisibilitySelectionMatches(JsonElement baseline, JsonElement current)
    {
        static HashSet<string>? Strings(JsonElement source, string property)
        {
            if (!source.TryGetProperty(property, out var items) || items.ValueKind != JsonValueKind.Array)
                return null;
            var values = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in items.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) return null;
                values.Add(item.GetString()!);
            }
            return values;
        }
        if (ReadRevision(current) < ReadRevision(baseline)
            || !baseline.TryGetProperty("visibility", out var before)
            || !current.TryGetProperty("visibility", out var after)
            || before.ValueKind != JsonValueKind.Object || after.ValueKind != JsonValueKind.Object)
            return false;
        var beforeKeys = Strings(before, "visibleKeys");
        var afterKeys = Strings(after, "visibleKeys");
        var beforeSessions = Strings(baseline, "selectedSessionIds");
        var afterSessions = Strings(current, "selectedSessionIds");
        return beforeKeys is not null && afterKeys is not null && beforeSessions is not null
            && afterSessions is not null && beforeKeys.SetEquals(afterKeys)
            && beforeSessions.SetEquals(afterSessions);
    }

    // A shared revision also changes for donations and our own layout backup.
    // Rebase only a setting whose source fields and selected sessions still match.
    // The DB still compares the final revision, protecting changes after this read.
    private static bool SettingsSelectionMatches(string action, JsonElement baseline, JsonElement current)
    {
        if (action == "save-visibility") return VisibilitySelectionMatches(baseline, current);
        var beforeSessions = ReadSessionIds(baseline, "selectedSessionIds");
        var afterSessions = ReadSessionIds(current, "selectedSessionIds");
        if (ReadRevision(current) < ReadRevision(baseline) || beforeSessions is null
            || afterSessions is null || !beforeSessions.SetEquals(afterSessions)) return false;
        static bool Same(JsonElement before, JsonElement after, string property)
            => before.TryGetProperty(property, out var a) && after.TryGetProperty(property, out var b)
                && a.ValueKind == JsonValueKind.Object && b.ValueKind == JsonValueKind.Object
                && JsonNode.DeepEquals(JsonNode.Parse(a.GetRawText()), JsonNode.Parse(b.GetRawText()));
        if (!Same(baseline, current, action == "save-merge-rules" ? "merge" : "size")) return false;
        // Size commands can include a prepared layout, whose grouping must still match.
        return action != "save-size-rules" || Same(baseline, current, "merge");
    }

    private JsonElement Localize(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText()) as JsonObject
            ?? throw new InvalidDataException("풍벽지 편집 상태가 올바르지 않습니다.");
        // Keep the server's layout separately from local grouping for conflict checks.
        root["serverLayoutBase"] = root["groups"]?.DeepClone();
        var localById = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var localByImageKey = new Dictionary<string, string>(StringComparer.Ordinal);
        using (var overlay = JsonDocument.Parse(_wallpaper.SnapshotBytes()))
        {
            if (overlay.RootElement.TryGetProperty("localDisplayRules", out var localRules)
                && localRules.ValueKind == JsonValueKind.True)
            {
                ApplyLocalRulesToEditor(root, overlay.RootElement);
            }
            if (overlay.RootElement.TryGetProperty("tiles", out var tiles)
                && tiles.ValueKind == JsonValueKind.Array)
            {
                foreach (var tile in tiles.EnumerateArray())
                {
                    if (!tile.TryGetProperty("id", out var idValue)
                        || !tile.TryGetProperty("imageUrl", out var urlValue)
                        || idValue.ValueKind != JsonValueKind.String
                        || urlValue.ValueKind != JsonValueKind.String) continue;
                    var id = idValue.GetString();
                    var url = urlValue.GetString();
                    if (url?.StartsWith("/overlay/", StringComparison.Ordinal) != true) continue;
                    var localUrl = "http://127.0.0.1:43120" + url;
                    if (!string.IsNullOrWhiteSpace(id)) localById[id] = localUrl;
                    if (tile.TryGetProperty("imageKey", out var keyValue)
                        && keyValue.ValueKind == JsonValueKind.String
                        && !string.IsNullOrWhiteSpace(keyValue.GetString()))
                        localByImageKey[keyValue.GetString()!] = localUrl;
                }
            }
        }
        WallpaperEditorImageLocalizer.Replace(root, localById, localByImageKey);
        root["overlayUrl"] = "http://127.0.0.1:43120/overlay/wallpaper";
        root["overlayAvailable"] = true;
        root["localAgentOverlay"] = true;
        root["offlinePending"] = _wallpaper.PendingLayout() is not null;
        var pending = _wallpaper.PendingLayout();
        if (pending is not null) ApplyLayoutNode(root, pending.Tiles);
        return JsonSerializer.SerializeToElement(root);
    }

    private static JsonElement ApplyLayoutToEditorState(JsonElement source, JsonElement tiles)
    {
        var root = JsonNode.Parse(source.GetRawText()) as JsonObject
            ?? throw new InvalidDataException("풍벽지 편집 상태가 올바르지 않습니다.");
        ApplyLayoutNode(root, tiles);
        root["offlinePending"] = true;
        return JsonSerializer.SerializeToElement(root);
    }

    private static void ApplyLayoutNode(JsonObject root, JsonElement tiles)
    {
        var byId = tiles.EnumerateArray().ToDictionary(
            tile => tile.GetProperty("id").GetString()!,
            tile => tile.Clone(),
            StringComparer.OrdinalIgnoreCase);
        // The local renderer rebuilds groups from raw tiles, so update both views.
        if (root["tiles"] is JsonArray rawTiles)
            foreach (var tile in rawTiles.OfType<JsonObject>())
            {
                if (tile["id"]?.GetValue<string>() is not string id || !byId.TryGetValue(id, out var saved)) continue;
                var layout = JsonNode.Parse(saved.GetRawText())!.AsObject();
                layout.Remove("id");
                tile["layout"] = layout;
            }
        if (root["groups"] is not JsonArray groups) return;
        foreach (var item in groups.OfType<JsonObject>())
        {
            if (item["tileIds"] is not JsonArray ids) continue;
            var firstId = ids.Select(value => value?.GetValue<string?>()).FirstOrDefault(id => id is not null && byId.ContainsKey(id));
            if (firstId is null) continue;
            var layout = byId[firstId];
            foreach (var property in new[] { "x", "y", "width", "height", "layer" })
                item[property] = layout.GetProperty(property).GetInt32();
            item["layoutColumns"] = layout.GetProperty("columns").GetInt32();
            item["layoutRows"] = layout.GetProperty("rows").GetInt32();
            item["nextSide"] = layout.GetProperty("nextSide").GetString();
            item["manualLayout"] = true;
        }
    }

    private static JsonElement CaptureLayoutFromEditorState(JsonElement state, JsonElement tiles)
    {
        var requested = tiles.ValueKind == JsonValueKind.Array
            ? tiles.EnumerateArray().Select(tile => tile.GetProperty("id").GetString()).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var captured = new JsonArray();
        var groups = state.TryGetProperty("serverLayoutBase", out var serverGroups)
            && serverGroups.ValueKind == JsonValueKind.Array ? serverGroups
            : state.TryGetProperty("groups", out var displayGroups) ? displayGroups : default;
        if (groups.ValueKind == JsonValueKind.Array)
        {
            foreach (var group in groups.EnumerateArray())
            {
                if (!group.TryGetProperty("tileIds", out var ids) || ids.ValueKind != JsonValueKind.Array) continue;
                foreach (var idValue in ids.EnumerateArray())
                {
                    var id = idValue.GetString();
                    if (id is null || !requested.Contains(id)) continue;
                    captured.Add(LayoutRecordFromGroup(group, id));
                }
            }
        }
        return JsonSerializer.SerializeToElement(captured);
    }

    private static JsonObject LayoutRecordFromGroup(JsonElement group, string id)
    {
        static int Int(JsonElement source, string name, int fallback)
            => source.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : fallback;
        static string Side(JsonElement source)
            => source.TryGetProperty("nextSide", out var value) && value.GetString() == "left" ? "left" : "right";
        return new JsonObject
        {
            ["id"] = id,
            ["x"] = Int(group, "x", 0),
            ["y"] = Int(group, "y", 0),
            ["width"] = Int(group, "width", 240),
            ["height"] = Int(group, "height", 226),
            ["columns"] = Int(group, "layoutColumns", Int(group, "slotColumns", 2)),
            ["rows"] = Int(group, "layoutRows", Int(group, "rowsPerColumn", 1)),
            ["nextSide"] = Side(group),
            ["layer"] = Int(group, "layer", 1)
        };
    }

    private static bool LayoutMatchesBase(JsonElement state, JsonElement baseTiles)
    {
        if (baseTiles.ValueKind != JsonValueKind.Array) return false;
        var current = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        if (state.TryGetProperty("groups", out var groups) && groups.ValueKind == JsonValueKind.Array)
        {
            foreach (var group in groups.EnumerateArray())
            {
                if (!group.TryGetProperty("tileIds", out var ids) || ids.ValueKind != JsonValueKind.Array) continue;
                foreach (var idValue in ids.EnumerateArray())
                {
                    var id = idValue.GetString();
                    if (id is not null) current[id] = LayoutRecordFromGroup(group, id);
                }
            }
        }
        foreach (var item in baseTiles.EnumerateArray())
        {
            var id = item.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
            if (id is null || !current.TryGetValue(id, out var layout)) return false;
            if (!JsonNode.DeepEquals(JsonNode.Parse(item.GetRawText()), layout)) return false;
        }
        return true;
    }

    private JsonElement? LoadCache()
    {
        if (_cacheLoaded) return _memoryCache;
        _cacheLoaded = true;
        try
        {
            var bytes = File.ReadAllBytes(_cachePath);
            if (bytes.Length is < 2 or > MaximumCacheBytes) return null;
            using var document = JsonDocument.Parse(bytes);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;
            _cacheBytes = bytes;
            return _memoryCache = document.RootElement.Clone();
        }
        catch { return null; }
    }

    private JsonElement BuildFallbackState(JsonElement? metadata = null)
    {
        using var document = JsonDocument.Parse(_wallpaper.SnapshotBytes());
        var source = document.RootElement;
        var sizeRules = source.TryGetProperty("sizeRanges", out var sizeValue) && sizeValue.ValueKind == JsonValueKind.Array
            ? sizeValue.EnumerateArray().Select(rule => rule.Clone()).ToArray() : [];
        var canvasWidth = source.TryGetProperty("canvasWidth", out var widthValue) ? widthValue.GetInt32() : 1920;
        var canvasHeight = source.TryGetProperty("canvasHeight", out var heightValue) ? heightValue.GetInt32() : 1080;
        var sourceTiles = source.TryGetProperty("tiles", out var tileValues)
            && tileValues.ValueKind == JsonValueKind.Array ? tileValues.EnumerateArray().Select(value => value.Clone()).ToArray() : [];
        var groups = new JsonArray();
        var catalog = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var layer = 0;
        foreach (var grouping in sourceTiles.GroupBy(tile => tile.TryGetProperty("groupKey", out var key)
                     ? key.GetString() ?? "unknown" : "unknown"))
        {
            var tiles = grouping.ToArray();
            if (tiles.Length == 0) continue;
            var first = tiles[0];
            var configuredWidth = 240;
            foreach (var rule in sizeRules)
            {
                if (!rule.TryGetProperty("min", out var min) || !min.TryGetInt32(out var lower)
                    || !rule.TryGetProperty("max", out var max) || !max.TryGetInt32(out var upper)
                    || !rule.TryGetProperty("width", out var ruleWidth) || !ruleWidth.TryGetInt32(out var pixels)
                    || pixels < 80 || pixels > 480) continue;
                if (tiles.All(tile => tile.TryGetProperty("displayKind", out var kind) && kind.GetString() == "donation"
                    && tile.TryGetProperty("amount", out var amount) && amount.TryGetInt32(out var n) && n >= lower && n <= upper))
                { configuredWidth = pixels; break; }
            }
            JsonElement? savedLayout = tiles.Select(tile => tile.TryGetProperty("layout", out var value)
                    && value.ValueKind == JsonValueKind.Object ? value.Clone() : (JsonElement?)null)
                .FirstOrDefault(value => value is not null);
            var index = layer++;
            var x = savedLayout?.GetProperty("x").GetInt32() ?? (index % 6) * 300;
            var y = savedLayout?.GetProperty("y").GetInt32() ?? (index / 6) * 250;
            var width = Math.Max(80, Math.Min(canvasWidth, savedLayout?.GetProperty("width").GetInt32() ?? configuredWidth));
            var height = Math.Max(60, Math.Min(canvasHeight,
                savedLayout?.GetProperty("height").GetInt32() ?? (int)Math.Ceiling((226 + Math.Max(0, tiles.Length - 1) * 46) * configuredWidth / 240.0)));
            var rows = savedLayout is not null && savedLayout.Value.TryGetProperty("rows", out var rowValue)
                && rowValue.ValueKind == JsonValueKind.Number ? rowValue.GetInt32() : Math.Max(1, tiles.Length);
            var columns = savedLayout is not null && savedLayout.Value.TryGetProperty("columns", out var columnValue)
                && columnValue.ValueKind == JsonValueKind.Number ? columnValue.GetInt32() : 1;
            var nextSide = savedLayout is not null && savedLayout.Value.TryGetProperty("nextSide", out var sideValue)
                && sideValue.GetString() == "left" ? "left" : "right";
            var savedLayer = savedLayout is not null && savedLayout.Value.TryGetProperty("layer", out var layerValue)
                && layerValue.ValueKind == JsonValueKind.Number ? layerValue.GetInt32() : index + 1;
            var cards = new JsonArray();
            var ids = new JsonArray();
            for (var cardIndex = 0; cardIndex < tiles.Length; cardIndex++)
            {
                var card = JsonNode.Parse(tiles[cardIndex].GetRawText()) as JsonObject ?? new JsonObject();
                card["x"] = 0; card["y"] = Math.Min(cardIndex, rows - 1) * 46;
                card["width"] = 240; card["height"] = 226;
                cards.Add(card);
                ids.Add(tiles[cardIndex].GetProperty("id").GetString());
                var visibilityKey = tiles[cardIndex].TryGetProperty("visibilityKey", out var visibleValue)
                    ? visibleValue.GetString() : null;
                if (!string.IsNullOrWhiteSpace(visibilityKey) && !catalog.ContainsKey(visibilityKey))
                    catalog[visibilityKey] = new JsonObject
                    {
                        ["key"] = visibilityKey,
                        ["amount"] = tiles[cardIndex].TryGetProperty("amount", out var amountValue) ? amountValue.GetInt32() : 0,
                        ["displayKind"] = tiles[cardIndex].TryGetProperty("displayKind", out var kindValue) ? kindValue.GetString() : "donation",
                        ["count"] = 1,
                        ["visible"] = true
                    };
                else if (!string.IsNullOrWhiteSpace(visibilityKey))
                    catalog[visibilityKey]!["count"] = (catalog[visibilityKey]!["count"]?.GetValue<int>() ?? 0) + 1;
            }
            var group = new JsonObject
            {
                ["id"] = grouping.Key,
                ["amount"] = first.TryGetProperty("amount", out var amount) ? amount.GetInt32() : 0,
                ["displayKind"] = first.TryGetProperty("displayKind", out var kind) ? kind.GetString() : "donation",
                ["source"] = first.TryGetProperty("source", out var imageSource) ? imageSource.GetString() : "none",
                ["imageUrl"] = first.TryGetProperty("imageUrl", out var imageUrl) ? imageUrl.GetString() : null,
                ["imageKey"] = first.TryGetProperty("imageKey", out var imageKey) ? imageKey.GetString() : null,
                ["tileIds"] = ids,
                ["cards"] = cards,
                ["x"] = Math.Max(0, Math.Min(x, canvasWidth - width)),
                ["y"] = Math.Max(0, Math.Min(y, canvasHeight - height)),
                ["width"] = width,
                ["height"] = height,
                ["layer"] = savedLayer,
                ["layoutColumns"] = savedLayout is null ? null : JsonValue.Create(columns),
                ["layoutRows"] = savedLayout is null ? null : JsonValue.Create(rows),
                ["columns"] = Math.Max(1, (int)Math.Ceiling((double)tiles.Length / rows)),
                ["slotColumns"] = columns,
                ["rowsPerColumn"] = rows,
                ["scale"] = 1,
                ["cardWidth"] = configuredWidth,
                ["cardHeight"] = 226,
                ["rowStep"] = 46,
                ["columnGap"] = 0,
                ["contentWidth"] = width,
                ["contentHeight"] = height,
                ["direction"] = "ltr",
                ["nextSide"] = nextSide,
                ["manualLayout"] = savedLayout is not null
            };
            groups.Add(group);
        }
        var revision = source.TryGetProperty("revision", out var revisionValue) ? revisionValue.GetInt64() : 0;
        var root = new JsonObject
        {
            ["ok"] = true,
            ["revision"] = revision,
            ["displayKey"] = "local-cache",
            ["session"] = sourceTiles.Length == 0 ? null : new JsonObject
            {
                ["id"] = "local-cache",
                ["state"] = "offline",
                ["canvasWidth"] = canvasWidth,
                ["canvasHeight"] = canvasHeight,
                ["startedAt"] = null,
                ["isLive"] = false
            },
            ["totalTiles"] = sourceTiles.Length,
            ["visibleTiles"] = sourceTiles.Length,
            ["hiddenTiles"] = 0,
            ["visibility"] = new JsonObject { ["visibleKeys"] = new JsonArray(catalog.Keys.Select(key => JsonValue.Create(key)).ToArray()) },
            ["catalog"] = new JsonArray(catalog.Values.Select(value => value.DeepClone()).ToArray()),
            ["merge"] = new JsonObject { ["rules"] = new JsonArray(), ["savedRules"] = new JsonArray(), ["activeForCurrentUser"] = false },
            ["size"] = new JsonObject { ["rules"] = new JsonArray(sizeRules.Select(rule => JsonNode.Parse(rule.GetRawText())).ToArray()), ["savedRules"] = new JsonArray(sizeRules.Select(rule => JsonNode.Parse(rule.GetRawText())).ToArray()), ["activeForCurrentUser"] = false },
            ["live"] = new JsonObject { ["isLive"] = false, ["state"] = "offline" },
            ["hasManualLayout"] = groups.OfType<JsonObject>().Any(group => group["manualLayout"]?.GetValue<bool>() == true),
            ["groups"] = groups,
            ["tiles"] = new JsonArray(sourceTiles.Select(tile => JsonNode.Parse(tile.GetRawText())).ToArray()),
            ["sessions"] = new JsonArray(),
            ["selectedSessionIds"] = new JsonArray(),
            ["overlayUrl"] = "http://127.0.0.1:43120/overlay/wallpaper",
            ["overlayAvailable"] = true,
            ["localAgentOverlay"] = true,
            ["retentionDays"] = 7,
            ["maxVisibleTiles"] = 216,
            ["layoutSaveProtocol"] = 3,
            ["offline"] = true,
            ["offlinePending"] = _wallpaper.PendingLayout() is not null
        };
        if (metadata is not null)
        {
            foreach (var property in metadata.Value.EnumerateObject())
                if (property.Name is not ("groups" or "tiles" or "size" or "merge" or "revision" or "hasManualLayout" or "offlinePending"))
                    root[property.Name] = JsonNode.Parse(property.Value.GetRawText());
            // A cached selection/catalog includes hidden tiles and real session IDs.
            root["revision"] = Math.Max(revision, ReadRevision(metadata.Value));
            if (!source.TryGetProperty("mergeRanges", out _) && metadata.Value.TryGetProperty("merge", out var inheritedMerge))
                root["merge"] = JsonNode.Parse(inheritedMerge.GetRawText());
        }
        ApplyLocalRulesToEditor(root, source);
        WallpaperEditorImageLocalizer.Replace(root,
            sourceTiles.Where(tile => tile.TryGetProperty("imageUrl", out var url) && url.ValueKind == JsonValueKind.String
                && url.GetString()!.StartsWith("/overlay/", StringComparison.Ordinal))
                .ToDictionary(tile => tile.GetProperty("id").GetString()!, tile => "http://127.0.0.1:43120" + tile.GetProperty("imageUrl").GetString()),
            new Dictionary<string, string>());
        return JsonSerializer.SerializeToElement(root);
    }

    private static void ApplyLocalRulesToEditor(JsonObject root, JsonElement overlay)
    {
        foreach (var (field, name) in new[] { ("mergeRanges", "merge"), ("sizeRanges", "size") })
            if (overlay.TryGetProperty(field, out var rules) && rules.ValueKind == JsonValueKind.Array)
                root[name] = new JsonObject
                {
                    ["rules"] = JsonNode.Parse(rules.GetRawText()),
                    ["savedRules"] = JsonNode.Parse(rules.GetRawText()),
                    ["activeForCurrentUser"] = true
                };
        if (root["tiles"] is JsonArray && root["merge"]?["savedRules"] is JsonArray mergeRules)
            WallpaperOverlayState.ApplyMergeGrouping(root, mergeRules);
        // Regrouping and geometry are derived by the bundled shared layout renderer.
        root["localRulesLayout"] = true;
        root["settingsProtocol"] = 2;
        root["displayKey"] = (root["displayKey"]?.GetValue<string>() ?? "local").Split(":local-rules:")[0]
            + ":local-rules:" + (overlay.TryGetProperty("displayRevision", out var display) ? display.GetString() : "");
    }

    private async Task SaveCacheAsync(JsonElement state, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(state);
        if (bytes.Length > MaximumCacheBytes) throw new InvalidDataException("풍벽지 편집 상태가 너무 큽니다.");
        if (_cacheBytes is not null && bytes.AsSpan().SequenceEqual(_cacheBytes)) return;
        var temporary = _cachePath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, cancellationToken);
            File.Move(temporary, _cachePath, true);
            _cacheBytes = bytes;
            _memoryCache = state.Clone();
            _cacheLoaded = true;
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
    }
}
