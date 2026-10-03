using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace HurogiCollector;

// Local presentation only. The owning coordinator supplies the account-scoped root.
internal sealed class WallpaperAppearance
{
    private readonly string _path;
    private readonly object _gate = new();
    private JsonObject _state = Defaults();
    private long _version;
    private string _error = "";
    private static JsonObject Defaults() => new() { ["enabled"] = false, ["fontUrl"] = "", ["nameColor"] = "#e33732", ["textColor"] = "#161616", ["backgroundColor"] = "#ffffff", ["fontSize"] = 18 };
    internal WallpaperAppearance(string root)
    {
        _path = Path.Combine(root, "wallpaper-appearance-v1.json");
        if (!File.Exists(_path)) return;
        try
        {
            if (new FileInfo(_path).Length > 8192) throw new InvalidDataException();
            using var document = JsonDocument.Parse(File.ReadAllBytes(_path));
            _state = Validate(document.RootElement);
        }
        catch { _error = "커스텀 설정을 읽지 못했습니다. 기존 파일을 보존했습니다."; }
    }
    private static JsonObject Validate(JsonElement value)
    {
        var result = Defaults();
        result["enabled"] = value.GetProperty("enabled").GetBoolean();
        var url = value.GetProperty("fontUrl").GetString() ?? "";
        if (url.Length > 2048 || (url.Length > 0 && (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0
            || uri.IsLoopback || Uri.CheckHostName(uri.IdnHost) != UriHostNameType.Dns
            || !Regex.IsMatch(uri.AbsolutePath, @"\.(woff2?|ttf|otf)$", RegexOptions.IgnoreCase))))
            throw new InvalidDataException("HTTPS 웹폰트 파일 링크(.woff2, .woff, .ttf, .otf)를 입력해주세요.");
        result["fontUrl"] = url;
        foreach (var key in new[] { "nameColor", "textColor", "backgroundColor" })
        {
            var color = value.GetProperty(key).GetString() ?? "";
            if (!Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$")) throw new InvalidDataException("색상은 #RRGGBB 형식으로 입력해주세요.");
            result[key] = color.ToLowerInvariant();
        }
        var size = value.GetProperty("fontSize").GetInt32();
        if (size is < 4 or > 72) throw new InvalidDataException("글자 크기는 4~72px 사이로 입력해주세요.");
        result["fontSize"] = size;
        return result;
    }
    internal JsonElement View
    {
        get { lock (_gate) { var value = _state.DeepClone().AsObject(); value["version"] = _version; value["error"] = _error; return JsonSerializer.SerializeToElement(value); } }
    }
    internal JsonElement Decorate(JsonElement source)
    {
        var root = JsonNode.Parse(source.GetRawText())!.AsObject(); var view = View;
        root["appearance"] = JsonNode.Parse(view.GetRawText());
        root["displayKey"] = (root["displayKey"]?.ToString() ?? "") + ":appearance:" + view.GetProperty("version").GetInt64();
        return JsonSerializer.SerializeToElement(root);
    }
    internal void Apply(JsonElement control, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_error.Length != 0) throw new InvalidDataException(_error);
            var action = control.GetProperty("action").GetString();
            var next = action == "appearance-reset" ? Defaults() : action == "appearance-save"
                ? Validate(control.GetProperty("appearance")) : throw new InvalidDataException("지원하지 않는 커스텀 요청입니다.");
            token.ThrowIfCancellationRequested();
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temporary = _path + ".tmp";
            try { File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(next)); token.ThrowIfCancellationRequested(); File.Move(temporary, _path, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            _state = next; _version++;
        }
    }
}
