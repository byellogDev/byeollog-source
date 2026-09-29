using System.Text.Json;
using System.Text.Json.Nodes;

namespace HurogiCollector;

// Presentation settings live in the workspace directory, never in the donation ledger.
internal sealed class WallpaperDetachedCards
{
    private readonly string _path;
    private readonly object _gate = new();
    private JsonObject _state = new() { ["ranges"] = new JsonArray(), ["positions"] = new JsonObject() };
    private long _version;
    private string _error = "";
    internal WallpaperDetachedCards(string root)
    {
        _path = Path.Combine(root, "wallpaper-detached-v1.json");
        if (!File.Exists(_path)) return;
        try
        {
            if (new FileInfo(_path).Length > 2 * 1024 * 1024) throw new InvalidDataException();
            var saved = JsonNode.Parse(File.ReadAllBytes(_path))!.AsObject();
            ValidateRanges(saved["ranges"]!);
            var positions = saved["positions"]!.AsObject();
            if (positions.Count > 4096) throw new InvalidDataException();
            foreach (var pair in positions) ValidatePosition(pair.Key, pair.Value!);
            _state = saved;
        }
        catch { _error = "묶음 해제 설정을 읽지 못했습니다. 저장 파일은 보존됩니다."; }
    }
    internal JsonElement View
    {
        get { lock (_gate) { var view = _state.DeepClone().AsObject(); view["version"] = _version; view["error"] = _error; return JsonSerializer.SerializeToElement(view); } }
    }
    internal JsonElement Decorate(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText())!.AsObject();
        var view = View;
        root["detached"] = JsonNode.Parse(view.GetRawText());
        root["displayKey"] = (root["displayKey"]?.ToString() ?? "") + ":detached:" + view.GetProperty("version").GetInt64();
        return JsonSerializer.SerializeToElement(root);
    }
    private static void ValidateRanges(JsonNode node)
    {
        if (node is not JsonArray ranges || ranges.Count > 20) throw new InvalidDataException("범위는 최대 20개까지 저장할 수 있습니다.");
        int previous = 0;
        foreach (var range in ranges)
        {
            var min = range?["min"]?.GetValue<int>() ?? 0;
            var max = range?["max"]?.GetValue<int>() ?? 0;
            if (min < 1 || max < min || max > 1_000_000 || min <= previous)
                throw new InvalidDataException("범위를 작은 수부터, 겹치지 않게 입력해주세요. (1~1,000,000)");
            previous = max;
        }
    }
    private static void ValidatePosition(string id, JsonNode position)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("카드 식별자가 올바르지 않습니다.");
        var x = position["x"]!.GetValue<int>(); var y = position["y"]!.GetValue<int>();
        var width = position["width"]!.GetValue<int>(); var height = position["height"]!.GetValue<int>();
        if (x < 0 || y < 0 || width < 40 || height < 20 || (long)x + width > 1920 || (long)y + height > 1080)
            throw new InvalidDataException("카드가 화면 범위를 벗어났습니다.");
    }
    internal void Apply(JsonElement control, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        lock (_gate)
        {
            token.ThrowIfCancellationRequested();
            if (_error.Length != 0) throw new InvalidDataException(_error);
            var next = _state.DeepClone().AsObject();
            var action = control.GetProperty("action").GetString();
            if (action == "detached-ranges")
            {
                var ranges = JsonNode.Parse(control.GetProperty("ranges").GetRawText())!;
                ValidateRanges(ranges); next["ranges"] = ranges;
                // Supplied positions preserve the current visual placement when first detaching.
                if (control.TryGetProperty("positions", out var positions))
                {
                    if (positions.ValueKind != JsonValueKind.Object || positions.EnumerateObject().Count() > 216) throw new InvalidDataException("카드 배치가 올바르지 않습니다.");
                    foreach (var p in positions.EnumerateObject())
                    {
                        var position = JsonNode.Parse(p.Value.GetRawText())!; ValidatePosition(p.Name, position);
                        next["positions"]!.AsObject().Remove(p.Name);
                        next["positions"]![p.Name] = position;
                    }
                }
            }
            else if (action == "detached-layout")
            {
                var id = control.GetProperty("id").GetString()!;
                var position = JsonNode.Parse(control.GetProperty("position").GetRawText())!;
                ValidatePosition(id, position);
                next["positions"]!.AsObject().Remove(id);
                next["positions"]![id] = position;
            }
            else throw new InvalidDataException("지원하지 않는 카드 설정입니다.");
            var records = next["positions"]!.AsObject();
            while (records.Count > 4096) records.Remove(records.First().Key);
            var temp = _path + ".tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            try { File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(next)); token.ThrowIfCancellationRequested(); File.Move(temp, _path, true); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
            _state = next; _version++;
        }
    }
}
