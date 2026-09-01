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
    private readonly string _assetDirectory;
    private readonly Action<string> _log;
    private readonly HttpClient _http;
    private readonly Func<Uri, CancellationToken, Task<byte[]>>? _authenticatedDownloader;
    private readonly object _gate = new();
    private readonly Dictionary<string, CachedAsset> _assets = new(StringComparer.Ordinal);
    private byte[] _stateBytes = EmptyStateBytes(0);
    private long _revision;
    private bool _disposed;
    private static readonly string[] CompactAssetFields =
    [
        "source", "imageUrl", "imageKey", "imageSha256", "imageMimeType",
        "imageByteSize", "imageWidth", "imageHeight"
    ];

    private sealed record CachedAsset(string Path, string MimeType);

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
        Func<Uri, CancellationToken, Task<byte[]>>? authenticatedDownloader)
    {
        _statePath = Path.Combine(rootPath, "wallpaper-overlay-state-v1.json");
        _assetDirectory = Path.Combine(rootPath, "wallpaper-assets-v1");
        _log = log;
        _authenticatedDownloader = authenticatedDownloader;
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
    }

    public long Revision
    {
        get { lock (_gate) return _revision; }
    }

    public byte[] SnapshotBytes()
    {
        lock (_gate) return _stateBytes.ToArray();
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

        var previousByKey = PreviousLocalAssetsByKey();
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
            if (remoteUrl is null)
                throw new InvalidDataException("풍벽지 이미지 주소가 없어 기존 화면을 유지합니다.");
            try
            {
                var token = await CacheRemoteImageAsync(remoteUrl, tile, cancellationToken);
                previousByKey[imageKey] = token;
                tile["imageUrl"] = "/overlay/wallpaper-assets/" + token;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log("풍벽지 이미지 로컬 캐시 보류 · 기존 화면 유지 · type=" + ex.GetType().Name);
                throw;
            }
        }

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
            _revision = sync.Revision;
        }
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
            if (!response.IsSuccessStatusCode) throw new IOException("풍벽지 이미지를 받지 못했습니다.");
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
                ".png" => "image/png", ".jpg" => "image/jpeg", ".webp" => "image/webp", ".gif" => "image/gif", _ => null
            };
            if (mime is not null && IsSha256(token)) _assets[token] = new CachedAsset(path, mime);
        }
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
            _revision = StateNeedsAssetRepair(document.RootElement) ? 0 : value;
            if (_revision == 0 && value > 0)
                _log("풍벽지 이미지 상태 자가복구 예약 · previousRevision=" + value);
        }
        catch { }
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
        "image/png" => ".png", "image/jpeg" => ".jpg", "image/webp" => ".webp", "image/gif" => ".gif", _ => ".bin"
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
