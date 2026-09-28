using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

// Every async operation captures one context. Paths, pending layouts, revisions,
// image dictionaries and application queues are never shared across accounts.
internal sealed class WallpaperWorkspaceContext : IDisposable
{
    internal string WorkspaceId { get; }
    internal string RootPath { get; }
    internal WallpaperOverlayState State { get; private set; }
    internal WallpaperEditorCoordinator Editor { get; private set; }
    internal WallpaperApplicationQueue? Applications { get; set; }
    internal CancellationToken Token => _stop.Token;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _prepare = new(1, 1);
    private readonly string _legacyRoot;
    private readonly Func<bool> _signedIn;
    private readonly Func<JsonElement?, CancellationToken, Task<JsonElement>> _send;
    private readonly Func<long> _epoch;
    private readonly Action<string> _log;
    private readonly Func<Uri, CancellationToken, Task<byte[]>>? _download;
    private readonly Task? _priorRetirement;
    private readonly Action _changed;
    private bool _prepared;
    private int _disposed;
    internal Task Retired { get; private set; } = Task.CompletedTask;

    internal WallpaperWorkspaceContext(string root, string workspaceId, Func<bool> signedIn,
        Func<JsonElement?, CancellationToken, Task<JsonElement>> send, Func<long> epoch,
        Action<string> log, Action changed,
        Func<Uri, CancellationToken, Task<byte[]>>? download = null, Task? priorRetirement = null)
    {
        WorkspaceId = Guid.TryParse(workspaceId, out var id) ? id.ToString("D") : "";
        // Signed-out storage is deliberately empty and separate from every account.
        RootPath = Path.Combine(root, "wallpaper-workspaces-v1", WorkspaceId.Length == 0 ? "signed-out" : WorkspaceId);
        Directory.CreateDirectory(RootPath);
        _legacyRoot = root; _signedIn = signedIn; _send = send; _epoch = epoch;
        _log = log; _changed = changed; _download = download;
        _priorRetirement = priorRetirement;
        State = NewState(); Editor = NewEditor();
    }

    private WallpaperOverlayState NewState() => new(RootPath, _log, handler: null, authenticatedDownloader: _download);
    private WallpaperEditorCoordinator NewEditor()
    {
        var editor = new WallpaperEditorCoordinator(
            () => !_stop.IsCancellationRequested && WorkspaceId.Length != 0 && _signedIn(),
            async (control, token) =>
            {
                _stop.Token.ThrowIfCancellationRequested();
                if (!_signedIn()) throw new OperationCanceledException("연결 계정이 변경되었습니다.");
                return await _send(control, token);
            }, _epoch, State, RootPath, _log, scheduleInitialBackup: false);
        editor.StateChanged += _changed;
        return editor;
    }

    internal async Task PrepareAsync(CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, Token);
        await _prepare.WaitAsync(linked.Token);
        try
        {
            if (_prepared) return;
            if (_priorRetirement is not null)
            {
                await _priorRetirement.WaitAsync(linked.Token);
                await Editor.DrainAsync();
                State.Dispose(); State = NewState(); Editor = NewEditor();
            }
            // Already scoped caches work offline without any server request.
            if (WorkspaceId.Length != 0 && !File.Exists(Path.Combine(RootPath, LegacyFiles[1]))
                && !File.Exists(Path.Combine(RootPath, LegacyFiles[0]))
                && File.Exists(Path.Combine(_legacyRoot, LegacyFiles[1])))
            {
                if (!_signedIn()) return; // retry proof on the first online operation
                try
                {
                    if (await TryImportLegacyAsync(linked.Token))
                    {
                        await Editor.DrainAsync();
                        State.Dispose();
                        State = NewState(); Editor = NewEditor();
                        _changed();
                        _log("풍벽지 기존 배치·캐시 계정별 복사 이관 완료 · 원본 보존");
                    }
                    else _log("풍벽지 기존 공용 캐시 소유권 확인 불가 · 원본 보존 · 계정별 서버 상태 사용");
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _log("풍벽지 기존 캐시 이관 보류 · 원본 보존 · type=" + ex.GetType().Name);
                }
            }
            linked.Token.ThrowIfCancellationRequested();
            _prepared = true;
            Editor.Baekdusan.Start();
        }
        finally { _prepare.Release(); }
    }

    // Snapshot is published LAST. A interrupted copy cannot masquerade as a
    // complete migrated snapshot; the original legacy directory is never changed.
    // Rebuild editor/session metadata from the authorized server response. The
    // legacy editor could belong to a different account than the tile snapshot.
    private static readonly string[] LegacyFiles = ["wallpaper-layout-pending-v1.json", "wallpaper-overlay-state-v1.json"];
    private async Task<bool> TryImportLegacyAsync(CancellationToken token)
    {
        var files = new Dictionary<string, byte[]>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var assets = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in LegacyFiles)
        {
            var path = Path.Combine(_legacyRoot, name);
            if (!File.Exists(path)) continue;
            var info = new FileInfo(path);
            if (info.Length is < 2 or > 4194304) return false;
            var bytes = await File.ReadAllBytesAsync(path, token);
            using var document = JsonDocument.Parse(bytes);
            if (!document.RootElement.TryGetProperty("tiles", out var tiles) || tiles.ValueKind != JsonValueKind.Array) return false;
            foreach (var tile in tiles.EnumerateArray())
            {
                if (tile.ValueKind != JsonValueKind.Object || !tile.TryGetProperty("id", out var tileId)
                    || tileId.ValueKind != JsonValueKind.String || !Guid.TryParse(tileId.GetString(), out var id)) return false;
                ids.Add(id.ToString("D"));
            }
            Collect(document.RootElement, ids, assets);
            files[name] = bytes;
        }
        if (ids.Count is < 1 or > 864) return false;
        var proof = await _send(JsonSerializer.SerializeToElement(new { action = "verify-cache-ownership", tileIds = ids.ToArray() }), token);
        token.ThrowIfCancellationRequested();
        if (!proof.TryGetProperty("owned", out var owned) || owned.ValueKind != JsonValueKind.True
            || !proof.TryGetProperty("workspaceId", out var workspace) || workspace.GetString() != WorkspaceId) return false;
        var destination = Path.Combine(RootPath, "wallpaper-assets-v1");
        Directory.CreateDirectory(destination);
        foreach (var hash in assets)
        foreach (var extension in new[] { ".png", ".jpg", ".gif", ".webp" })
        {
            token.ThrowIfCancellationRequested();
            var source = Path.Combine(_legacyRoot, "wallpaper-assets-v1", hash + extension);
            if (!File.Exists(source) || new FileInfo(source).Length > 12 * 1024 * 1024) continue;
            File.Copy(source, Path.Combine(destination, hash + extension), true);
        }
        foreach (var name in LegacyFiles)
        {
            if (!files.TryGetValue(name, out var bytes)) continue;
            var target = Path.Combine(RootPath, name);
            var temporary = target + ".import-" + Guid.NewGuid().ToString("N");
            try
            {
                await File.WriteAllBytesAsync(temporary, bytes, token);
                token.ThrowIfCancellationRequested();
                File.Move(temporary, target, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        return true;
    }

    private static void Collect(JsonElement value, HashSet<string> ids, HashSet<string> assets)
    {
        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) Collect(item, ids, assets);
        }
        else if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                // Tile UUIDs only, not session/group UUIDs. A tile has an amount
                // (snapshot/card) or x/width (pending layout).
                if (property.Name == "id" && property.Value.ValueKind == JsonValueKind.String
                    && (value.TryGetProperty("amount", out _) || value.TryGetProperty("width", out _))
                    && Guid.TryParse(property.Value.GetString(), out var id)) ids.Add(id.ToString("D"));
                if (property.Name == "tileIds" && property.Value.ValueKind == JsonValueKind.Array)
                    foreach (var item in property.Value.EnumerateArray())
                        if (item.ValueKind == JsonValueKind.String && Guid.TryParse(item.GetString(), out var tileId)) ids.Add(tileId.ToString("D"));
                if (property.Name == "imageUrl" && property.Value.ValueKind == JsonValueKind.String)
                {
                    var match = Regex.Match(property.Value.GetString() ?? "", @"(?:^|http://127\.0\.0\.1:43120)/overlay/wallpaper-assets/([a-f0-9]{64})$");
                    if (match.Success) assets.Add(match.Groups[1].Value);
                }
                Collect(property.Value, ids, assets);
            }
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Cancel();
        Applications?.Dispose();
        Editor.Dispose();
        Retired = Task.Run(async () =>
        {
            await _prepare.WaitAsync();
            try
            {
                try { if (Applications is not null) await Applications.WhenIdle; }
                catch (Exception ex) { _log("이전 풍벽지 작업 종료 · type=" + ex.GetType().Name); }
                await Editor.DrainAsync();
                State.Dispose();
            }
            finally { _prepare.Release(); }
        });
    }
}
