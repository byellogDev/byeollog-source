using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

// Workspace-local presentation choices. Never deletes donations or rewrites layouts.
internal sealed class WallpaperHiddenCards
{
    private const int Limit = 10000;
    private readonly string _path;
    private readonly object _gate = new();
    private JsonObject _cards = new();
    private long _version;
    private string _error = "";

    internal WallpaperHiddenCards(string root)
    {
        _path = Path.Combine(root, "wallpaper-hidden-cards-v1.json");
        if (!File.Exists(_path)) return;
        try
        {
            if (new FileInfo(_path).Length > 4 * 1024 * 1024) throw new InvalidDataException();
            var cards = JsonNode.Parse(File.ReadAllBytes(_path))!.AsObject();
            if (cards.Count > Limit) throw new InvalidDataException();
            foreach (var (id, card) in cards)
                if (!Guid.TryParseExact(id, "D", out _) || card is not JsonObject || card["id"]?.GetValue<string>() != id)
                    throw new InvalidDataException();
            _cards = cards;
        }
        catch { _error = "숨긴 풍벽지 설정을 읽지 못했습니다. 원래 저장 파일은 보존됩니다."; }
    }

    internal JsonElement View
    {
        get { lock (_gate) return JsonSerializer.SerializeToElement(new { version = _version, error = _error, cards = _cards }); }
    }

    internal JsonElement Decorate(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText())!.AsObject();
        var view = View;
        root["hiddenCards"] = JsonNode.Parse(view.GetRawText());
        root["displayKey"] = (root["displayKey"]?.ToString() ?? "") + ":hidden:" + view.GetProperty("version").GetInt64();
        return JsonSerializer.SerializeToElement(root);
    }

    private static IEnumerable<JsonElement> Items(JsonElement root, string key) =>
        root.TryGetProperty(key, out var values) && values.ValueKind == JsonValueKind.Array ? values.EnumerateArray() : [];

    private static JsonElement? Find(JsonElement source, string id)
    {
        var tiles = Items(source, "tiles").Concat(Items(source, "groups").SelectMany(group => Items(group, "cards")));
        if (source.TryGetProperty("baekdusan", out var baek))
        {
            var selected = Items(baek, "selectedSessionIds").Select(x => x.GetString()).ToHashSet();
            tiles = tiles.Concat(Items(baek, "runs").Where(run => selected.Contains(run.GetProperty("sessionId").GetString())).SelectMany(run => Items(run, "members")));
        }
        foreach (var tile in tiles)
            if (tile.TryGetProperty("id", out var value) && value.GetString() == id) return tile;
        return null;
    }

    internal void Apply(JsonElement control, JsonElement source, CancellationToken token)
    {
        lock (_gate)
        {
            token.ThrowIfCancellationRequested();
            if (_error.Length != 0) throw new InvalidDataException(_error);
            if (!control.TryGetProperty("id", out var value) || value.ValueKind != JsonValueKind.String
                || !Guid.TryParseExact(value.GetString(), "D", out _)) throw new InvalidDataException("풍벽지 식별자가 올바르지 않습니다.");
            var id = value.GetString()!;
            var action = control.GetProperty("action").GetString();
            var next = _cards.DeepClone().AsObject();
            if (action == "card-hide")
            {
                if (next.ContainsKey(id)) return; // Exact retries remain idempotent.
                var tile = Find(source, id) ?? throw new InvalidDataException("현재 방송에서 카드를 찾지 못했습니다. 새로고침 후 다시 선택해주세요.");
                if (next.Count >= Limit) throw new InvalidDataException("숨김 보관 한도에 도달했습니다. 숨긴 풍벽지를 복원한 후 다시 시도해주세요.");
                var record = new JsonObject { ["id"] = id, ["hiddenAt"] = DateTimeOffset.UtcNow.ToString("O") };
                // Only copy display metadata from the trusted snapshot, never caller-supplied text or URLs.
                foreach (var field in new[] { "actorName", "amount", "displayKind", "receivedAt", "sessionId" })
                    if (tile.TryGetProperty(field, out var item)) record[field] = JsonNode.Parse(item.GetRawText());
                next[id] = record;
            }
            else if (action == "card-restore") { if (!next.Remove(id)) return; }
            else throw new InvalidDataException("지원하지 않는 숨김 설정입니다.");
            var bytes = JsonSerializer.SerializeToUtf8Bytes(next);
            if (bytes.Length > 4 * 1024 * 1024) throw new InvalidDataException("숨긴 풍벽지 보관 용량을 초과했습니다.");
            var temp = _path + ".tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            try { File.WriteAllBytes(temp, bytes); token.ThrowIfCancellationRequested(); File.Move(temp, _path, true); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
            _cards = next; _version++;
        }
    }
}
