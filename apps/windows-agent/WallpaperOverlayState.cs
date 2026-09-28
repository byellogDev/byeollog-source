using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

internal sealed record VNextWallpaperSync(
    bool Changed,
    long Revision,
    bool Unavailable,
    JsonElement? State);
internal sealed record VNextAgentClaimResult(VNextAgentJob? Job, VNextWallpaperSync? Wallpaper);
internal sealed record LocalWallpaperImageMask(
    int Width, int Height, int MaskWidth, int MaskHeight, string Alpha, double Density);

/// <summary>
/// Realtime 풍벽지 변경 신호를 세대 번호로 보존한다. snapshot 조회나 이미지
/// 적용 중 새 신호가 와도 이전 작업의 완료가 더 최신 신호를 지우지 못한다.
/// </summary>
internal sealed class WallpaperSyncRequestTracker
{
    private long _requested;
    private long _completed;

    public long Request() => Interlocked.Increment(ref _requested);

    public long Capture() => Volatile.Read(ref _requested);

    public bool Pending => Capture() > Volatile.Read(ref _completed);

    public void CompleteThrough(long generation)
    {
        if (generation <= 0) return;
        while (true)
        {
            var current = Volatile.Read(ref _completed);
            if (current >= generation) return;
            if (Interlocked.CompareExchange(ref _completed, generation, current) == current) return;
        }
    }
}

internal sealed class WallpaperOverlayState : IDisposable
{
    private const int MaximumStateBytes = 4 * 1024 * 1024;
    private const int MaximumImageBytes = 12 * 1024 * 1024;
    private readonly string _statePath;
    private readonly string _pendingLayoutPath;
    private readonly string _assetDirectory;
    private readonly Action<string> _log;
    private readonly HttpClient _http;
    private readonly Func<Uri, CancellationToken, Task<byte[]>>? _authenticatedDownloader;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _commitGate = new(1, 1);
    private readonly Dictionary<string, CachedAsset> _assets = new(StringComparer.Ordinal);
    private byte[] _stateBytes = EmptyStateBytes(0);
    private long _revision;
    private long _snapshotRevision;
    private bool _hasPendingAssets;
    private bool _hasSizeRanges;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _imageDownloadTimeout;
    private readonly SemaphoreSlim _downloadSlots = new(4, 4);
    private readonly Dictionary<string, ImageFailure> _imageFailures = new(StringComparer.Ordinal);
    private sealed record ImageFailure(int Attempts, DateTimeOffset RetryAt);
    private bool _disposed;
    private PendingWallpaperLayout? _pendingLayout;
    private static readonly string[] CompactAssetFields =
    [
        "source", "imageUrl", "imageKey", "imageSha256", "imageMimeType",
        "imageByteSize", "imageWidth", "imageHeight"
    ];

    private sealed record CachedAsset(string Path, string MimeType);
    internal sealed record PendingWallpaperLayout(string Generation, long BaseRevision, JsonElement Tiles,
        JsonElement BaseTiles, long? AcknowledgedRevision = null);

    public WallpaperOverlayState(string rootPath, Action<string> log)
        : this(rootPath, log, null, null)
    {
    }

    internal WallpaperOverlayState(string rootPath, Action<string> log, HttpMessageHandler? handler)
        : this(rootPath, log, handler, null)
    {
    }

    internal WallpaperOverlayState(
        string rootPath,
        Action<string> log,
        HttpMessageHandler? handler,
        Func<Uri, CancellationToken, Task<byte[]>>? authenticatedDownloader,
        TimeProvider? clock = null, TimeSpan? imageDownloadTimeout = null)
    {
        _statePath = Path.Combine(rootPath, "wallpaper-overlay-state-v1.json");
        _pendingLayoutPath = Path.Combine(rootPath, "wallpaper-layout-pending-v1.json");
        _assetDirectory = Path.Combine(rootPath, "wallpaper-assets-v1");
        _log = log;
        _authenticatedDownloader = authenticatedDownloader;
        _clock = clock ?? TimeProvider.System;
        _imageDownloadTimeout = imageDownloadTimeout ?? TimeSpan.FromSeconds(15);
        Directory.CreateDirectory(_assetDirectory);
        _http = new HttpClient(handler ?? new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5)
        })
        {
            Timeout = TimeSpan.FromSeconds(15)
        };
        LoadAssets();
        LoadState();
        LoadPendingLayout();
        PruneOldUnreferencedAssets();
    }

    public long Revision
    {
        get { lock (_gate) return _revision; }
    }

    internal bool HasPendingAssets { get { lock (_gate) return _hasPendingAssets; } }
    // A full first snapshot upgrades old caches, without resetting acknowledged state.
    internal long SyncRevision { get { lock (_gate) return _hasSizeRanges ? _revision : 0; } }

    internal string DisplayRevision
    {
        get { lock (_gate) { using var state = JsonDocument.Parse(_stateBytes); return state.RootElement.TryGetProperty("displayRevision", out var value) ? value.GetString() ?? "" : ""; } }
    }

    internal TimeSpan PendingAssetRetryDelay
    {
        get
        {
            lock (_gate)
            {
                var seconds = _imageFailures.Count == 0 ? 5 : (_imageFailures.Values.Min(f => f.RetryAt) - _clock.GetUtcNow()).TotalSeconds;
                return TimeSpan.FromSeconds(Math.Clamp(seconds, 5, 300));
            }
        }
    }

    internal Func<JsonElement>? BaekdusanView { get; set; }
    private byte[]? _baekBaseBytes, _baekDisplayBytes;
    private long _baekViewVersion = -1;
    internal byte[] DisplaySnapshotBytes()
    {
        if (BaekdusanView is null) return SnapshotBytes();
        var view = BaekdusanView();
        lock (_gate)
        {
            if (view.GetProperty("runs").GetArrayLength() == 0) return _stateBytes.ToArray();
            var version = view.GetProperty("version").GetInt64();
            if (ReferenceEquals(_stateBytes, _baekBaseBytes) && version == _baekViewVersion)
                return _baekDisplayBytes!.ToArray();
            var root = JsonNode.Parse(_stateBytes)!.AsObject();
            root["baekdusan"] = JsonNode.Parse(view.GetRawText());
            root["displayRevision"] = (root["displayRevision"]?.ToString() ?? root["revision"]?.ToString() ?? "0") + ":baek:" + version;
            _baekBaseBytes = _stateBytes; _baekViewVersion = version;
            _baekDisplayBytes = JsonSerializer.SerializeToUtf8Bytes(root);
            return _baekDisplayBytes.ToArray();
        }
    }

    public byte[] SnapshotBytes()
    {
        lock (_gate) return _stateBytes.ToArray();
    }

    internal PendingWallpaperLayout? PendingLayout()
    {
        lock (_gate)
        {
            if (_pendingLayout is null) return null;
            return new PendingWallpaperLayout(
                _pendingLayout.Generation,
                _pendingLayout.BaseRevision,
                _pendingLayout.Tiles.Clone(),
                _pendingLayout.BaseTiles.Clone(),
                _pendingLayout.AcknowledgedRevision);
        }
    }

    internal async Task<string> ApplyLocalLayoutAsync(
        long baseRevision,
        JsonElement layoutTiles,
        JsonElement? baseLayoutTiles,
        CancellationToken cancellationToken)
    {
        if (baseRevision < 0 || layoutTiles.ValueKind != JsonValueKind.Array
            || layoutTiles.GetArrayLength() > 216)
            throw new InvalidDataException("풍벽지 배치 정보가 올바르지 않습니다.");

        await _commitGate.WaitAsync(cancellationToken);
        try
        {
            byte[] current;
            lock (_gate) current = _stateBytes.ToArray();
            var root = JsonNode.Parse(current) as JsonObject
                ?? throw new InvalidDataException("로컬 풍벽지 상태가 올바르지 않습니다.");
            var normalized = NormalizeLayoutTiles(layoutTiles);
            var baseTiles = baseLayoutTiles is { ValueKind: JsonValueKind.Array }
                ? NormalizeLayoutTiles(baseLayoutTiles.Value)
                : CaptureLayoutTiles(root, normalized);
            ApplyLayout(root, normalized);
            root["displayRevision"] = Guid.NewGuid().ToString("N");
            var generation = Guid.NewGuid().ToString("N");
            var pendingBytes = JsonSerializer.SerializeToUtf8Bytes(new JsonObject
            {
                ["schemaVersion"] = 1,
                ["generation"] = generation,
                ["baseRevision"] = baseRevision,
                ["tiles"] = normalized.DeepClone(),
                ["baseTiles"] = baseTiles.DeepClone()
            });
            var finalBytes = JsonSerializer.SerializeToUtf8Bytes(root);
            if (finalBytes.Length > MaximumStateBytes)
                throw new InvalidDataException("풍벽지 로컬 상태 크기가 제한을 초과했습니다.");

            await WriteAtomicAsync(_pendingLayoutPath, pendingBytes, cancellationToken);
            await WriteAtomicAsync(_statePath, finalBytes, cancellationToken);
            var pendingElement = JsonSerializer.SerializeToElement(normalized);
            var baseElement = JsonSerializer.SerializeToElement(baseTiles);
            lock (_gate)
            {
                _pendingLayout = new PendingWallpaperLayout(generation, baseRevision, pendingElement.Clone(), baseElement.Clone());
                _stateBytes = finalBytes;
            }
            return generation;
        }
        finally { _commitGate.Release(); }
    }

    internal async Task AcknowledgePendingLayoutAsync(string generation, long revision, CancellationToken cancellationToken, JsonElement? acknowledgedTiles = null)
    {
        await _commitGate.WaitAsync(cancellationToken);
        try
        {
            PendingWallpaperLayout? pending;
            lock (_gate) pending = _pendingLayout;
            if (pending is null) return;
            if (pending.Generation != generation)
            {
                if (pending.AcknowledgedRevision is null && acknowledgedTiles is JsonElement tiles)
                {
                    var rebased = pending with { BaseRevision = revision, BaseTiles = tiles.Clone() };
                    await WriteAtomicAsync(_pendingLayoutPath, JsonSerializer.SerializeToUtf8Bytes(new
                    {
                        schemaVersion = 1,
                        generation = rebased.Generation,
                        baseRevision = rebased.BaseRevision,
                        tiles = rebased.Tiles,
                        baseTiles = rebased.BaseTiles
                    }), cancellationToken);
                    lock (_gate)
                    {
                        if (_pendingLayout?.Generation == pending.Generation)
                            _pendingLayout = rebased;
                    }
                }
                return;
            }
            // Keep the local override until a snapshot at/after this ACK arrives.
            // Otherwise a snapshot already in flight could revert the placement.
            var acknowledged = pending with { AcknowledgedRevision = revision };
            await WriteAtomicAsync(_pendingLayoutPath, JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                generation,
                baseRevision = pending.BaseRevision,
                tiles = pending.Tiles,
                baseTiles = pending.BaseTiles,
                acknowledgedRevision = revision
            }), cancellationToken);
            lock (_gate) _pendingLayout = acknowledged;
        }
        finally { _commitGate.Release(); }
    }

    internal async Task ClearPendingLayoutAsync(string generation, CancellationToken cancellationToken)
    {
        await _commitGate.WaitAsync(cancellationToken);
        try { ClearPendingLayoutUnderCommitGate(generation); }
        finally { _commitGate.Release(); }
    }

    internal async Task ApplyLocalDisplayRulesAsync(
        JsonElement? mergeRanges,
        JsonElement? sizeRanges,
        CancellationToken cancellationToken)
    {
        if (mergeRanges is not null && mergeRanges.Value.ValueKind != JsonValueKind.Array
            || sizeRanges is not null && sizeRanges.Value.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("풍벽지 설정이 올바르지 않습니다.");
        await _commitGate.WaitAsync(cancellationToken);
        try
        {
            byte[] current;
            lock (_gate) current = _stateBytes.ToArray();
            var root = JsonNode.Parse(current) as JsonObject
                ?? throw new InvalidDataException("로컬 풍벽지 상태가 올바르지 않습니다.");
            if (mergeRanges is { ValueKind: JsonValueKind.Array })
            {
                var ranges = NormalizeMergeRanges(mergeRanges.Value);
                root["mergeRanges"] = ranges.DeepClone();
                ApplyMergeGrouping(root, ranges);
            }
            if (sizeRanges is { ValueKind: JsonValueKind.Array })
                root["sizeRanges"] = NormalizeSizeRanges(sizeRanges.Value).DeepClone();
            root["localDisplayRules"] = true;
            root["displayRevision"] = Guid.NewGuid().ToString("N");
            var finalBytes = JsonSerializer.SerializeToUtf8Bytes(root, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            if (finalBytes.Length > MaximumStateBytes)
                throw new InvalidDataException("풍벽지 로컬 상태 크기가 제한을 초과했습니다.");
            await WriteAtomicAsync(_statePath, finalBytes, cancellationToken);
            lock (_gate)
            {
                _stateBytes = finalBytes;
                _hasSizeRanges = root["sizeRanges"] is JsonArray;
            }
        }
        finally { _commitGate.Release(); }
    }

    private void ClearPendingLayoutUnderCommitGate(string generation)
    {
        lock (_gate)
        {
            if (_pendingLayout is null
                || !string.Equals(_pendingLayout.Generation, generation, StringComparison.Ordinal)) return;
            _pendingLayout = null;
            try { File.Delete(_pendingLayoutPath); } catch { }
        }
    }

    public async Task<bool> ApplyAsync(VNextWallpaperSync sync, CancellationToken cancellationToken)
    {
        if (!sync.Changed || sync.State is null) return false;
        if (sync.Revision < 0 || sync.State.Value.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("풍벽지 상태가 올바르지 않습니다.");
        var serialized = Encoding.UTF8.GetBytes(sync.State.Value.GetRawText());
        if (serialized.Length > MaximumStateBytes)
            throw new InvalidDataException("풍벽지 상태 크기가 제한을 초과했습니다.");

        var root = JsonNode.Parse(serialized) as JsonObject
            ?? throw new InvalidDataException("풍벽지 상태 JSON이 올바르지 않습니다.");
        var schemaVersion = root["schemaVersion"]?.GetValue<int>() ?? -1;
        if (schemaVersion == 2) ExpandCompactState(root);
        if (root["revision"]?.GetValue<long>() != sync.Revision
            || root["schemaVersion"]?.GetValue<int>() != 1
            || root["tiles"] is not JsonArray tiles
            || tiles.Count > 216)
            throw new InvalidDataException("풍벽지 상태 계약이 올바르지 않습니다.");

        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate) { if (sync.Revision < _snapshotRevision) return false; }
        var previousByKey = PreviousLocalAssetsByKey();
        var missing = new Dictionary<string, (JsonObject Descriptor, List<JsonObject> Tiles)>(StringComparer.Ordinal);
        foreach (var node in tiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (node is not JsonObject tile) continue;
            var imageKey = SafeString(tile["imageKey"], 2200);
            var remoteUrl = SafeString(tile["imageUrl"], 4096);
            if (imageKey is null) { tile["imageUrl"] = null; continue; }
            if (previousByKey.TryGetValue(imageKey, out var existingToken) && AssetExists(existingToken))
            {
                tile["imageUrl"] = "/overlay/wallpaper-assets/" + existingToken;
                continue;
            }
            var expectedHash = SafeString(tile["imageSha256"], 64);
            if (expectedHash is not null && IsSha256(expectedHash) && AssetExists(expectedHash))
            {
                previousByKey[imageKey] = expectedHash;
                tile["imageUrl"] = "/overlay/wallpaper-assets/" + expectedHash;
                continue;
            }
            if (!missing.TryGetValue(imageKey, out var group))
            {
                group = ((JsonObject)tile.DeepClone(), new List<JsonObject>());
                missing.Add(imageKey, group);
            }
            group.Tiles.Add(tile);
            tile["imageUrl"] = null;
        }

        // Publish cached images and all card labels before any network wait.
        if (!await CommitSnapshotAsync(sync.Revision, root, cancellationToken)) return false;
        lock (_gate)
            foreach (var key in _imageFailures.Keys.Where(key => !missing.ContainsKey(key)).ToArray()) _imageFailures.Remove(key);
        var downloads = missing.Select(async entry =>
            (Key: entry.Key, Token: await DownloadMissingImageAsync(entry.Key, entry.Value.Descriptor, cancellationToken))).ToList();
        try
        {
            while (downloads.Count > 0)
            {
                await Task.WhenAny(downloads);
                var changed = false;
                // Coalesce already-ready images into one disk commit without
                // delaying a healthy image behind a stalled download.
                foreach (var completed in downloads.Where(task => task.IsCompleted).ToArray())
                {
                    downloads.Remove(completed);
                    var result = await completed;
                    if (result.Token is null) continue;
                    foreach (var tile in missing[result.Key].Tiles)
                        tile["imageUrl"] = "/overlay/wallpaper-assets/" + result.Token;
                    changed = true;
                }
                // Each available image can appear independently of a stalled peer.
                if (changed) await CommitSnapshotAsync(sync.Revision, root, cancellationToken);
            }
        }
        finally
        {
            // Observe canceled siblings before releasing the caller's apply slot.
            try { await Task.WhenAll(downloads); } catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }
        PruneOldUnreferencedAssets();
        return true;
    }

    private async Task<string?> DownloadMissingImageAsync(string key, JsonObject descriptor, CancellationToken cancellationToken)
    {
        lock (_gate)
            if (_imageFailures.TryGetValue(key, out var failure) && _clock.GetUtcNow() < failure.RetryAt) return null;
        await _downloadSlots.WaitAsync(cancellationToken);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(_imageDownloadTimeout);
            var url = SafeString(descriptor["imageUrl"], 4096)
                ?? throw new InvalidDataException("풍벽지 이미지 주소가 없습니다.");
            var token = await CacheRemoteImageAsync(url, descriptor, deadline.Token);
            lock (_gate) _imageFailures.Remove(key);
            return token;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            int attempt;
            var permanent = ex is InvalidDataException || ex is HttpRequestException { StatusCode: HttpStatusCode.NotFound or HttpStatusCode.Gone or HttpStatusCode.Forbidden };
            lock (_gate)
            {
                attempt = _imageFailures.TryGetValue(key, out var previous) ? Math.Min(previous.Attempts + 1, 7) : 1;
                if (_imageFailures.Count >= 512) _imageFailures.Remove(_imageFailures.MinBy(item => item.Value.RetryAt).Key);
                var delay = Math.Min(300, (permanent ? 60 : 5) * Math.Pow(2, attempt - 1));
                _imageFailures[key] = new ImageFailure(attempt, _clock.GetUtcNow().AddSeconds(delay));
            }
            // One initial diagnostic, not one log per card/retry forever.
            if (attempt == 1) _log("풍벽지 이미지 다운로드 보류 · 정상 카드 유지 · type=" + ex.GetType().Name);
            return null;
        }
        finally { _downloadSlots.Release(); }
    }

    private async Task<bool> CommitSnapshotAsync(long revision, JsonObject source, CancellationToken cancellationToken)
    {
        var root = (JsonObject)source.DeepClone();
        var pendingAssets = ((JsonArray)root["tiles"]!).OfType<JsonObject>()
            .Count(tile => SafeString(tile["imageKey"], 2200) is not null && SafeString(tile["imageUrl"], 4096) is null);

        // Image downloading is outside this gate. Only the small atomic state
        // commit is serialized with local edits, so a slow CDN cannot stop editing.
        await _commitGate.WaitAsync(cancellationToken);
        try
        {
            if (revision < _snapshotRevision) return false;
            JsonElement? pendingTiles = null;
            string? confirmedGeneration = null;
            lock (_gate)
            {
                if (_pendingLayout is not null)
                {
                    if (_pendingLayout.AcknowledgedRevision is long acknowledged && revision >= acknowledged)
                        confirmedGeneration = _pendingLayout.Generation;
                    else pendingTiles = _pendingLayout.Tiles.Clone();
                }
            }
            JsonNode? previousState;
            lock (_gate) previousState = JsonNode.Parse(_stateBytes);
            if (previousState is JsonObject previous)
            {
                if (previous["mergeRanges"] is JsonArray mergeRanges)
                {
                    root["mergeRanges"] = mergeRanges.DeepClone();
                    ApplyMergeGrouping(root, NormalizeMergeRanges(JsonSerializer.SerializeToElement(mergeRanges)));
                }
                if (previous["sizeRanges"] is JsonArray sizeRanges)
                    root["sizeRanges"] = sizeRanges.DeepClone();
                if (previous["localDisplayRules"]?.GetValue<bool>() == true)
                    root["localDisplayRules"] = true;
            }
            if (pendingTiles is not null)
                ApplyLayout(root, NormalizeLayoutTiles(pendingTiles.Value));

            // Local display changes must not advance the server synchronization cursor.
            root["displayRevision"] = previousState?["displayRevision"]?.DeepClone();
            root["pendingAssetCount"] = pendingAssets;
            var changed = !JsonNode.DeepEquals(root, previousState);
            if (changed) root["displayRevision"] = Guid.NewGuid().ToString("N");

            var finalBytes = JsonSerializer.SerializeToUtf8Bytes(root, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            if (finalBytes.Length > MaximumStateBytes)
                throw new InvalidDataException("풍벽지 로컬 상태 크기가 제한을 초과했습니다.");
            if (changed) await WriteAtomicAsync(_statePath, finalBytes, cancellationToken);
            lock (_gate)
            {
                _stateBytes = finalBytes;
                _snapshotRevision = revision;
                _hasSizeRanges = root["sizeRanges"] is JsonArray;
                _hasPendingAssets = pendingAssets > 0;
                _revision = _hasPendingAssets
                    ? Math.Min(_revision, Math.Max(0, revision - 1))
                    : revision;
            }
            if (confirmedGeneration is not null) ClearPendingLayoutUnderCommitGate(confirmedGeneration);
        }
        finally { _commitGate.Release(); }
        return true;
    }

    private static void ExpandCompactState(JsonObject root)
    {
        if (root["assets"] is not JsonArray assets || assets.Count > 216
            || root["tiles"] is not JsonArray tiles)
            throw new InvalidDataException("압축 풍벽지 자산 계약이 올바르지 않습니다.");

        foreach (var node in tiles)
        {
            if (node is not JsonObject tile)
                throw new InvalidDataException("압축 풍벽지 카드 계약이 올바르지 않습니다.");
            var reference = tile["assetIndex"];
            tile.Remove("assetIndex");
            if (reference is null) continue;
            if (reference is not JsonValue value || !value.TryGetValue<int>(out var index)
                || index < 0 || index >= assets.Count || assets[index] is not JsonObject asset)
                throw new InvalidDataException("압축 풍벽지 자산 참조가 올바르지 않습니다.");
            foreach (var field in CompactAssetFields)
                tile[field] = asset[field]?.DeepClone();
        }
        root.Remove("assets");
        root["schemaVersion"] = 1;
    }

    public bool TryReadAsset(string token, out byte[] bytes, out string mimeType)
    {
        bytes = [];
        mimeType = "application/octet-stream";
        if (!IsSha256(token)) return false;
        CachedAsset? asset;
        lock (_gate) _assets.TryGetValue(token, out asset);
        if (asset is null) return false;
        try
        {
            var info = new FileInfo(asset.Path);
            if (!info.Exists || info.Length is < 1 or > MaximumImageBytes) return false;
            bytes = File.ReadAllBytes(asset.Path);
            mimeType = asset.MimeType;
            return string.Equals(Sha256Hex(bytes), token, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    internal LocalWallpaperImageMask CreateImageMask(string rawUrl)
    {
        const string pathPrefix = "/overlay/wallpaper-assets/";
        var path = rawUrl;
        if (Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri))
        {
            if (!uri.IsLoopback || uri.Port != 43120) throw new InvalidDataException("로컬 풍벽지 이미지 주소가 올바르지 않습니다.");
            path = uri.AbsolutePath;
        }
        if (!path.StartsWith(pathPrefix, StringComparison.Ordinal))
            throw new InvalidDataException("로컬 풍벽지 이미지 주소가 올바르지 않습니다.");
        var token = path[pathPrefix.Length..];
        if (!TryReadAsset(token, out var bytes, out _))
            throw new FileNotFoundException("로컬 풍벽지 이미지를 찾지 못했습니다.");
        using var stream = new MemoryStream(bytes, writable: false);
        using var image = Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true);
        using var bitmap = new Bitmap(image);
        const int maskSize = 96;
        var alpha = new byte[maskSize * maskSize];
        long total = 0;
        for (var y = 0; y < maskSize; y++)
            for (var x = 0; x < maskSize; x++)
            {
                var sourceX = Math.Min(bitmap.Width - 1, x * bitmap.Width / maskSize);
                var sourceY = Math.Min(bitmap.Height - 1, y * bitmap.Height / maskSize);
                var value = bitmap.GetPixel(sourceX, sourceY).A;
                alpha[y * maskSize + x] = value;
                total += value;
            }
        return new LocalWallpaperImageMask(
            bitmap.Width, bitmap.Height, maskSize, maskSize,
            Convert.ToBase64String(alpha), total / (double)(alpha.Length * 255));
    }

    private Dictionary<string, string> PreviousLocalAssetsByKey()
    {
        byte[] bytes;
        lock (_gate) bytes = _stateBytes.ToArray();
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            using var document = JsonDocument.Parse(bytes);
            if (!document.RootElement.TryGetProperty("tiles", out var tiles) || tiles.ValueKind != JsonValueKind.Array)
                return result;
            foreach (var tile in tiles.EnumerateArray())
            {
                if (!tile.TryGetProperty("imageKey", out var keyValue)
                    || keyValue.ValueKind != JsonValueKind.String
                    || !tile.TryGetProperty("imageUrl", out var urlValue)
                    || urlValue.ValueKind != JsonValueKind.String) continue;
                var key = keyValue.GetString();
                var url = urlValue.GetString();
                const string prefix = "/overlay/wallpaper-assets/";
                if (key is null || url is null || !url.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var token = url[prefix.Length..];
                if (IsSha256(token)) result[key] = token;
            }
        }
        catch { }
        return result;
    }

    private async Task<string> CacheRemoteImageAsync(string rawUrl, JsonObject descriptor, CancellationToken cancellationToken)
    {
        var uri = ValidateRemoteUri(rawUrl);
        byte[] bytes;
        if (IsAuthenticatedSignatureAsset(uri))
        {
            if (_authenticatedDownloader is null)
                throw new InvalidDataException("풍벽지 인증 이미지 다운로드 경로가 준비되지 않았습니다.");
            bytes = await _authenticatedDownloader(uri, cancellationToken);
        }
        else
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.TryAddWithoutValidation("Accept", "image/png,image/jpeg,image/webp,image/gif");
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode) throw new HttpRequestException("풍벽지 이미지를 받지 못했습니다.", null, response.StatusCode);
            if (response.Content.Headers.ContentLength is long declared && declared > MaximumImageBytes)
                throw new InvalidDataException("풍벽지 이미지 크기가 제한을 초과했습니다.");
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var destination = new MemoryStream();
            var buffer = new byte[32 * 1024];
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                if (destination.Length + read > MaximumImageBytes)
                    throw new InvalidDataException("풍벽지 이미지 크기가 제한을 초과했습니다.");
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            bytes = destination.ToArray();
        }
        if (bytes.Length is < 1 or > MaximumImageBytes)
            throw new InvalidDataException("풍벽지 이미지 크기가 제한을 초과했습니다.");
        // 일부 SOOP 정적 자산은 .jpg 주소와 image/jpeg 응답 헤더를 사용하면서
        // 실제 바이트는 PNG다. 외부 메타데이터가 아니라 파일 서명을 신뢰한다.
        var mime = DetectAndValidateImageBytes(bytes);
        var expectedSize = descriptor["imageByteSize"]?.GetValue<int?>();
        if (expectedSize is > 0 && expectedSize != bytes.Length)
            throw new InvalidDataException("풍벽지 이미지 크기가 서버 정보와 다릅니다.");
        var token = Sha256Hex(bytes);
        var expectedHash = SafeString(descriptor["imageSha256"], 64);
        if (expectedHash is not null && IsSha256(expectedHash)
            && !string.Equals(expectedHash, token, StringComparison.Ordinal))
            throw new InvalidDataException("풍벽지 이미지 해시가 서버 정보와 다릅니다.");
        var path = Path.Combine(_assetDirectory, token + Extension(mime));
        if (!File.Exists(path)) await WriteAtomicAsync(path, bytes, cancellationToken);
        lock (_gate) _assets[token] = new CachedAsset(path, mime);
        return token;
    }

    private static Uri ValidateRemoteUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo)
            || !uri.IsDefaultPort) throw new InvalidDataException("풍벽지 이미지 주소가 올바르지 않습니다.");
        var host = uri.IdnHost.ToLowerInvariant();
        var allowed = host == "offslvwaugvjotkywlus.supabase.co"
            || HostMatches(host, "sooplive.com")
            || HostMatches(host, "afreecatv.com")
            || HostMatches(host, "afreecatvcdn.com");
        if (!allowed) throw new InvalidDataException("허용되지 않은 풍벽지 이미지 호스트입니다.");
        return uri;
    }

    private static bool IsAuthenticatedSignatureAsset(Uri uri) =>
        string.Equals(uri.IdnHost, "offslvwaugvjotkywlus.supabase.co", StringComparison.OrdinalIgnoreCase)
        && uri.AbsolutePath.StartsWith(
            "/storage/v1/object/authenticated/byeollog-signature-assets/workspaces/",
            StringComparison.Ordinal);

    private static bool HostMatches(string host, string root) =>
        host == root || host.EndsWith("." + root, StringComparison.Ordinal);

    private static string DetectAndValidateImageBytes(byte[] bytes)
    {
        if (bytes.Length < 10) throw new InvalidDataException("풍벽지 이미지가 비어 있습니다.");
        var mime = bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })
            ? "image/png"
            : bytes[0] == 0xff && bytes[1] == 0xd8
                ? "image/jpeg"
                : bytes.AsSpan(0, 6).SequenceEqual("GIF87a"u8)
                    || bytes.AsSpan(0, 6).SequenceEqual("GIF89a"u8)
                        ? "image/gif"
                        : bytes.Length >= 12
                            && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8)
                            && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8)
                                ? "image/webp"
                                : throw new InvalidDataException("풍벽지 이미지 파일 형식이 올바르지 않습니다.");
        if (mime == "image/jpeg")
        {
            if (bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8
                || bytes[^2] != 0xff || bytes[^1] != 0xd9)
                throw new InvalidDataException("JPEG 풍벽지 헤더가 올바르지 않습니다.");
            return mime;
        }
        var dimensions = OverlayAssetValidator.Inspect(bytes, mime);
        if (dimensions.Width is < 1 or > 4096 || dimensions.Height is < 1 or > 4096)
            throw new InvalidDataException("풍벽지 이미지 해상도가 제한을 초과했습니다.");
        return mime;
    }

    private void LoadAssets()
    {
        foreach (var path in Directory.EnumerateFiles(_assetDirectory))
        {
            var token = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            var mime = Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".png" => "image/png",
                ".jpg" => "image/jpeg",
                ".webp" => "image/webp",
                ".gif" => "image/gif",
                _ => null
            };
            if (mime is not null && IsSha256(token)) _assets[token] = new CachedAsset(path, mime);
        }
    }

    private void PruneOldUnreferencedAssets(JsonObject? currentState = null)
    {
        try
        {
            currentState ??= JsonNode.Parse(SnapshotBytes()) as JsonObject;
            var referenced = new HashSet<string>(StringComparer.Ordinal);
            if (currentState?["tiles"] is JsonArray tiles)
            {
                foreach (var node in tiles)
                {
                    if (node is not JsonObject tile) continue;
                    var imageUrl = SafeString(tile["imageUrl"], 4096);
                    const string prefix = "/overlay/wallpaper-assets/";
                    if (imageUrl?.StartsWith(prefix, StringComparison.Ordinal) != true) continue;
                    var token = imageUrl[prefix.Length..];
                    if (IsSha256(token)) referenced.Add(token);
                }
            }

            List<(string Token, CachedAsset Asset)> candidates;
            lock (_gate)
            {
                candidates = _assets
                    .Where(item => !referenced.Contains(item.Key))
                    .Select(item => (item.Key, item.Value))
                    .ToList();
            }
            var cutoff = DateTime.UtcNow.AddHours(-24);
            var removed = 0;
            foreach (var candidate in candidates)
            {
                try
                {
                    var info = new FileInfo(candidate.Asset.Path);
                    if (!info.Exists || info.LastWriteTimeUtc > cutoff) continue;
                    File.Delete(candidate.Asset.Path);
                    lock (_gate)
                    {
                        if (_assets.TryGetValue(candidate.Token, out var current)
                            && string.Equals(current.Path, candidate.Asset.Path, StringComparison.OrdinalIgnoreCase))
                            _assets.Remove(candidate.Token);
                    }
                    removed++;
                }
                catch { }
            }
            if (removed > 0) _log("사용하지 않는 풍벽지 이미지 캐시 정리 · count=" + removed);
        }
        catch { }
    }

    private void LoadState()
    {
        try
        {
            var bytes = File.ReadAllBytes(_statePath);
            if (bytes.Length is < 2 or > MaximumStateBytes) return;
            using var document = JsonDocument.Parse(bytes);
            if (!document.RootElement.TryGetProperty("schemaVersion", out var schema)
                || schema.GetInt32() != 1
                || !document.RootElement.TryGetProperty("revision", out var revision)
                || !revision.TryGetInt64(out var value) || value < 0) return;
            _stateBytes = bytes;
            _snapshotRevision = value;
            _hasPendingAssets = StateNeedsAssetRepair(document.RootElement);
            // Refresh pre-size-rule caches once after upgrade, without touching their layout.
            _hasSizeRanges = document.RootElement.TryGetProperty("sizeRanges", out var sizes)
                && sizes.ValueKind == JsonValueKind.Array;
            _revision = _hasPendingAssets ? 0 : value;
            if (_revision == 0 && value > 0)
                _log("풍벽지 이미지 상태 자가복구 예약 · previousRevision=" + value);
        }
        catch { }
    }

    private void LoadPendingLayout()
    {
        try
        {
            var bytes = File.ReadAllBytes(_pendingLayoutPath);
            if (bytes.Length is < 2 or > 256 * 1024) return;
            using var document = JsonDocument.Parse(bytes);
            var root = document.RootElement;
            if (!root.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != 1
                || !root.TryGetProperty("generation", out var generationValue)
                || generationValue.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("baseRevision", out var revisionValue)
                || !revisionValue.TryGetInt64(out var baseRevision) || baseRevision < 0
                || !root.TryGetProperty("tiles", out var tilesValue)) return;
            var generation = generationValue.GetString();
            if (string.IsNullOrWhiteSpace(generation)) return;
            var normalized = NormalizeLayoutTiles(tilesValue);
            var baseTiles = root.TryGetProperty("baseTiles", out var baseValue)
                ? NormalizeLayoutTiles(baseValue)
                : normalized;
            _pendingLayout = new PendingWallpaperLayout(
                generation,
                baseRevision,
                JsonSerializer.SerializeToElement(normalized),
                JsonSerializer.SerializeToElement(baseTiles),
                root.TryGetProperty("acknowledgedRevision", out var ack) && ack.TryGetInt64(out var ackValue)
                    && ackValue >= baseRevision ? ackValue : null);
            var state = JsonNode.Parse(_stateBytes) as JsonObject;
            if (state is not null)
            {
                ApplyLayout(state, normalized);
                state["displayRevision"] = Guid.NewGuid().ToString("N");
                _stateBytes = JsonSerializer.SerializeToUtf8Bytes(state);
            }
        }
        catch { }
    }

    internal static JsonArray NormalizeLayoutTiles(JsonElement source)
    {
        if (source.ValueKind != JsonValueKind.Array || source.GetArrayLength() > 216)
            throw new InvalidDataException("풍벽지 배치 정보가 올바르지 않습니다.");
        var result = new JsonArray();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var value in source.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("풍벽지 배치 정보가 올바르지 않습니다.");
            var id = value.TryGetProperty("id", out var idValue) ? idValue.GetString()?.Trim().ToLowerInvariant() : null;
            var nextSide = value.TryGetProperty("nextSide", out var nextValue) ? nextValue.GetString() : null;
            var names = new[] { "x", "y", "width", "height", "columns", "rows", "layer" };
            var numbers = new int[names.Length];
            for (var index = 0; index < names.Length; index++)
                if (!value.TryGetProperty(names[index], out var number) || !number.TryGetInt32(out numbers[index]))
                    throw new InvalidDataException("풍벽지 배치 정보가 올바르지 않습니다.");
            if (!Guid.TryParseExact(id, "D", out _) || !ids.Add(id!)
                || nextSide is not ("left" or "right")
                || numbers[0] < 0 || numbers[1] < 0 || numbers[2] < 80 || numbers[3] < 60
                || (long)numbers[0] + numbers[2] > 1920 || (long)numbers[1] + numbers[3] > 1080
                || numbers[4] is < 1 or > 217 || numbers[5] is < 1 or > 216 || numbers[6] is < 1 or > 216)
                throw new InvalidDataException("풍벽지 카드가 편집 가능 영역을 벗어났습니다.");
            result.Add(new JsonObject
            {
                ["id"] = id,
                ["x"] = numbers[0],
                ["y"] = numbers[1],
                ["width"] = numbers[2],
                ["height"] = numbers[3],
                ["columns"] = numbers[4],
                ["rows"] = numbers[5],
                ["nextSide"] = nextSide,
                ["layer"] = numbers[6]
            });
        }
        return result;
    }

    private static JsonArray NormalizeMergeRanges(JsonElement source)
    {
        if (source.ValueKind != JsonValueKind.Array || source.GetArrayLength() > 20)
            throw new InvalidDataException("풍벽지 합병 범위는 최대 20개입니다.");
        var result = new JsonArray();
        var previousMax = 0;
        foreach (var value in source.EnumerateArray().Take(20))
        {
            if (value.ValueKind != JsonValueKind.Object
                || !value.TryGetProperty("min", out var minValue)
                || !value.TryGetProperty("max", out var maxValue)
                || !minValue.TryGetInt32(out var min)
                || !maxValue.TryGetInt32(out var max)
                || min < 1 || max < min || max > 1_000_000 || min <= previousMax)
                throw new InvalidDataException("풍벽지 합병 범위가 올바르지 않습니다.");
            result.Add(new JsonObject { ["min"] = min, ["max"] = max });
            previousMax = max;
        }
        return result;
    }

    private static JsonArray NormalizeSizeRanges(JsonElement source)
    {
        if (source.ValueKind != JsonValueKind.Array || source.GetArrayLength() > 20)
            throw new InvalidDataException("풍벽지 크기 범위는 최대 20개입니다.");
        var result = new JsonArray();
        var previousMax = 0;
        foreach (var value in source.EnumerateArray().Take(20))
        {
            if (value.ValueKind != JsonValueKind.Object
                || !value.TryGetProperty("min", out var minValue)
                || !value.TryGetProperty("max", out var maxValue)
                || !value.TryGetProperty("width", out var widthValue)
                || !minValue.TryGetInt32(out var min)
                || !maxValue.TryGetInt32(out var max)
                || !widthValue.TryGetInt32(out var width)
                || min < 1 || max < min || max > 1_000_000 || min <= previousMax
                || width < 80 || width > 480)
                throw new InvalidDataException("풍벽지 크기 범위가 올바르지 않습니다.");
            result.Add(new JsonObject { ["min"] = min, ["max"] = max, ["width"] = width });
            previousMax = max;
        }
        return result;
    }

    internal static void ApplyMergeGrouping(JsonObject root, JsonArray ranges)
    {
        if (root["tiles"] is not JsonArray tiles) return;
        var parsed = ranges.OfType<JsonObject>()
            .Select(item => (
                Min: item["min"]?.GetValue<int>() ?? 0,
                Max: item["max"]?.GetValue<int>() ?? 0))
            .Where(item => item.Min > 0 && item.Max >= item.Min)
            .ToArray();
        foreach (var node in tiles)
        {
            if (node is not JsonObject tile) continue;
            var amount = tile["amount"]?.GetValue<int>() ?? 0;
            var displayKind = SafeString(tile["displayKind"], 40) ?? "donation";
            if (displayKind == "challenge_success")
            {
                tile["groupKey"] = $"wallpaper-challenge-success-{amount}";
                tile["mergeRange"] = null;
                continue;
            }
            if (displayKind == "subscription")
            {
                tile["groupKey"] = $"wallpaper-subscription-{amount}";
                tile["mergeRange"] = null;
                continue;
            }
            var found = parsed.FirstOrDefault(range => amount >= range.Min && amount <= range.Max);
            if (found.Min > 0)
            {
                tile["groupKey"] = $"wallpaper-merge-{found.Min}-{found.Max}";
                tile["mergeRange"] = new JsonObject { ["min"] = found.Min, ["max"] = found.Max };
            }
            else
            {
                tile["groupKey"] = $"wallpaper-amount-{amount}";
                tile["mergeRange"] = null;
            }
        }
    }

    private static void ApplyLayout(JsonObject root, JsonArray layouts)
    {
        if (root["tiles"] is not JsonArray tiles) return;
        var byId = layouts.OfType<JsonObject>()
            .Where(item => SafeString(item["id"], 40) is not null)
            .ToDictionary(item => SafeString(item["id"], 40)!, item => item, StringComparer.OrdinalIgnoreCase);
        foreach (var node in tiles)
        {
            if (node is not JsonObject tile) continue;
            var id = SafeString(tile["id"], 40);
            if (id is null || !byId.TryGetValue(id, out var layout)) continue;
            tile["layout"] = new JsonObject
            {
                ["x"] = layout["x"]?.DeepClone(),
                ["y"] = layout["y"]?.DeepClone(),
                ["width"] = layout["width"]?.DeepClone(),
                ["height"] = layout["height"]?.DeepClone(),
                ["columns"] = layout["columns"]?.DeepClone(),
                ["rows"] = layout["rows"]?.DeepClone(),
                ["nextSide"] = layout["nextSide"]?.DeepClone(),
                ["layer"] = layout["layer"]?.DeepClone()
            };
        }
    }

    private static JsonArray CaptureLayoutTiles(JsonObject root, JsonArray requested)
    {
        var result = new JsonArray();
        if (root["tiles"] is not JsonArray tiles) return result;
        var requestedIds = requested.OfType<JsonObject>()
            .Select(item => SafeString(item["id"], 40))
            .Where(id => id is not null)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var node in tiles)
        {
            if (node is not JsonObject tile) continue;
            var id = SafeString(tile["id"], 40);
            if (id is null || !requestedIds.Contains(id)) continue;
            result.Add(LayoutRecordFromTile(tile, id));
        }
        return result;
    }

    private static JsonObject LayoutRecordFromTile(JsonObject tile, string id)
    {
        var layout = tile["layout"] as JsonObject;
        static int Int(JsonObject? source, string name, int fallback)
        {
            try { return source?[name]?.GetValue<int>() ?? fallback; }
            catch { return fallback; }
        }
        static string Side(JsonObject? source)
        {
            try { return source?["nextSide"]?.GetValue<string>() == "left" ? "left" : "right"; }
            catch { return "right"; }
        }
        return new JsonObject
        {
            ["id"] = id,
            ["x"] = Int(layout, "x", 0),
            ["y"] = Int(layout, "y", 0),
            ["width"] = Int(layout, "width", 240),
            ["height"] = Int(layout, "height", 226),
            ["columns"] = Int(layout, "columns", 2),
            ["rows"] = Int(layout, "rows", 1),
            ["nextSide"] = Side(layout),
            ["layer"] = Int(layout, "layer", 1)
        };
    }

    private bool StateNeedsAssetRepair(JsonElement root)
    {
        if (!root.TryGetProperty("tiles", out var tiles) || tiles.ValueKind != JsonValueKind.Array)
            return true;
        foreach (var tile in tiles.EnumerateArray())
        {
            if (tile.ValueKind != JsonValueKind.Object
                || !tile.TryGetProperty("imageKey", out var imageKey)
                || imageKey.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(imageKey.GetString()))
                continue;
            if (!tile.TryGetProperty("imageUrl", out var imageUrl)
                || imageUrl.ValueKind != JsonValueKind.String)
                return true;
            const string prefix = "/overlay/wallpaper-assets/";
            var localUrl = imageUrl.GetString();
            if (localUrl is null || !localUrl.StartsWith(prefix, StringComparison.Ordinal))
                return true;
            var token = localUrl[prefix.Length..];
            if (!IsSha256(token) || !AssetExists(token)) return true;
        }
        return false;
    }

    private bool AssetExists(string token)
    {
        lock (_gate) return _assets.TryGetValue(token, out var asset) && File.Exists(asset.Path);
    }

    private static string? SafeString(JsonNode? value, int max)
    {
        try
        {
            var text = value?.GetValue<string>()?.Trim();
            return string.IsNullOrEmpty(text) || text.Length > max ? null : text;
        }
        catch { return null; }
    }

    private static string Extension(string mime) => mime switch
    {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        _ => ".bin"
    };

    private static string Sha256Hex(ReadOnlySpan<byte> bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool IsSha256(string value) => value.Length == 64 && value.All(character =>
        character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static byte[] EmptyStateBytes(long revision) => Encoding.UTF8.GetBytes(
        $"{{\"schemaVersion\":1,\"revision\":{revision},\"canvasWidth\":1920,\"canvasHeight\":1080,\"tiles\":[]}}");

    private static async Task WriteAtomicAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, cancellationToken);
            File.Move(temporary, path, true);
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _http.Dispose();
    }
}
