using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace HurogiCollector;

/// <summary>
/// Converts the authenticated raw PostgREST snapshot into the exact local
/// overlay contract formerly produced by the Edge Function.  Keeping this
/// deterministic transform in the Agent removes an Edge invocation per
/// wallpaper change without changing visual rendering or action delivery.
/// </summary>
internal static partial class AgentWallpaperSnapshotMapper
{
    private const string SignatureBucketPath =
        "/storage/v1/object/authenticated/byeollog-signature-assets/";
    private static readonly string[] SoopHosts =
        ["sooplive.com", "afreecatv.com", "afreecatvcdn.com"];

    [GeneratedRegex("^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$",
        RegexOptions.CultureInvariant)]
    private static partial Regex VisibleKeyPattern();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();

    public static VNextWallpaperSync Build(
        JsonElement raw,
        string workspaceId,
        string supabaseUrl)
    {
        if (raw.ValueKind != JsonValueKind.Object)
            throw Invalid("풍벽지 직접 동기화 응답이 올바르지 않습니다.");
        var revision = Integer(raw, "revision", -1L);
        if (revision < 0) throw Invalid("풍벽지 직접 동기화 revision이 올바르지 않습니다.");
        if (!raw.TryGetProperty("changed", out var changedValue)
            || changedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw Invalid("풍벽지 직접 동기화 변경 상태가 올바르지 않습니다.");
        if (!changedValue.GetBoolean())
            return new VNextWallpaperSync(false, revision, false, null);

        var overlay = ObjectProperty(raw, "overlay");
        if (overlay.ValueKind != JsonValueKind.Object
            || !raw.TryGetProperty("tiles", out var rawTiles) || rawTiles.ValueKind != JsonValueKind.Array
            || !raw.TryGetProperty("sessions", out var rawSessions) || rawSessions.ValueKind != JsonValueKind.Array)
            throw Invalid("풍벽지 직접 동기화 필수 데이터가 없습니다.");
        var ranges = MergeRanges(overlay);
        var visibleKeys = VisibleKeys(overlay);
        var sessions = ObjectArray(raw, "sessions");
        var newest = sessions
            .OrderByDescending(item => Date(item, "startedAt"))
            .FirstOrDefault();
        var canvasWidth = Math.Max(1, Integer(newest, "canvasWidth", 1920));
        var canvasHeight = Math.Max(1, Integer(newest, "canvasHeight", 1080));

        var signatureAssets = new Dictionary<int, JsonObject>();
        foreach (var row in ObjectArray(raw, "signatures"))
        {
            var amount = Integer(row, "amount");
            var asset = ObjectProperty(row, "asset");
            var path = Text(asset, "storagePath", 1000);
            if (amount < 1 || !path.StartsWith($"workspaces/{workspaceId}/wallpaper/", StringComparison.Ordinal))
                continue;
            var descriptor = AssetDescriptor(asset);
            descriptor["imageUrl"] = supabaseUrl + SignatureBucketPath + EncodePath(path);
            descriptor["imageKey"] = "signature:" + path;
            descriptor["source"] = "signature";
            signatureAssets[amount] = descriptor;
        }

        var defaultAssets = new List<(int Min, int Max, JsonObject Asset)>();
        foreach (var row in ObjectArray(raw, "defaultDonationImages"))
        {
            var min = Integer(row, "minAmount");
            var max = Integer(row, "maxAmount", int.MaxValue);
            var asset = ObjectProperty(row, "asset");
            var path = Text(asset, "storagePath", 1000);
            if (min < 1 || max < min
                || !path.StartsWith($"workspaces/{workspaceId}/default-pc/", StringComparison.Ordinal))
                continue;
            var descriptor = AssetDescriptor(asset);
            descriptor["imageUrl"] = supabaseUrl + SignatureBucketPath + EncodePath(path);
            descriptor["imageKey"] = "workspace_default:" + path;
            descriptor["source"] = "workspace_default";
            defaultAssets.Add((min, max, descriptor));
        }

        var rows = ObjectArray(raw, "tiles");
        var latestAssets = new Dictionary<int, JsonObject>();
        foreach (var row in rows)
        {
            var displayKind = DisplayKind(row);
            if (displayKind is "challenge_success" or "subscription"
                || Text(row, "assetSource", 40) != "soop") continue;
            var amount = Integer(row, "amount");
            var asset = ObjectProperty(row, "asset");
            const string source = "soop";
            var imageUrl = NormalizeSoopUrl(Value(asset, "url"));
            if (amount < 1 || imageUrl is null) continue;
            var descriptor = AssetDescriptor(asset);
            descriptor["imageUrl"] = imageUrl;
            var identity = Text(asset, "storagePath", 2048);
            if (identity.Length == 0) identity = Text(asset, "url", 2048);
            if (identity.Length == 0) identity = SafeText(imageUrl, 2048);
            descriptor["imageKey"] = source + ":" + identity;
            descriptor["source"] = source;
            latestAssets[amount] = descriptor;
        }

        var tiles = new JsonArray();
        foreach (var row in rows)
        {
            var amount = Integer(row, "amount");
            if (amount < 1) continue;
            var displayKind = DisplayKind(row);
            var visibilityKey = $"{displayKind}:{amount}";
            if (!visibleKeys.Contains(visibilityKey)) continue;

            var asset = ObjectProperty(row, "asset");
            var officialEventUrl = displayKind is "challenge_success" or "subscription"
                ? NormalizeSoopUrl(Value(asset, "url"))
                : null;
            JsonObject selected;
            if (displayKind == "subscription")
            {
                selected = EmptyAsset();
                selected["imageUrl"] = officialEventUrl;
                selected["imageKey"] = officialEventUrl is null ? null : "soop:" + officialEventUrl;
                selected["source"] = officialEventUrl is null ? "none" : "soop";
            }
            else if (officialEventUrl is not null)
            {
                selected = AssetDescriptor(asset);
                selected["imageUrl"] = officialEventUrl;
                selected["imageKey"] = "soop:" + officialEventUrl;
                selected["source"] = "soop";
            }
            else if (signatureAssets.TryGetValue(amount, out var signature))
                selected = (JsonObject)signature.DeepClone();
            else if (latestAssets.TryGetValue(amount, out var latest))
                selected = (JsonObject)latest.DeepClone();
            else if (defaultAssets.FirstOrDefault(item => amount >= item.Min && amount <= item.Max) is var custom
                && custom.Asset is not null)
                selected = (JsonObject)custom.Asset.DeepClone();
            else
            {
                var fallbackUrl = DefaultCeremonyUrl(amount);
                selected = EmptyAsset();
                selected["imageUrl"] = fallbackUrl;
                selected["imageKey"] = "soop_default:" + fallbackUrl;
                selected["source"] = "soop_default";
            }

            var tile = new JsonObject
            {
                ["id"] = Text(row, "id", 40),
                ["sequenceNo"] = Integer(row, "sequenceNo"),
                ["sessionId"] = Text(row, "sessionId", 40),
                ["actorName"] = Text(row, "actorName", 120) is { Length: > 0 } actor ? actor : "익명",
                ["amount"] = amount,
                ["displayKind"] = displayKind,
                ["visibilityKey"] = visibilityKey,
                ["receivedAt"] = Text(row, "receivedAt", 80),
                ["layout"] = Layout(row, canvasWidth, canvasHeight)
            };
            ApplyGrouping(tile, amount, displayKind, ranges);
            foreach (var property in selected)
                tile[property.Key] = property.Value?.DeepClone();
            tiles.Add(tile);
        }

        var state = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["revision"] = revision,
            ["canvasWidth"] = canvasWidth,
            ["canvasHeight"] = canvasHeight,
            ["sizeRanges"] = SizeRanges(overlay),
            ["tiles"] = tiles
        };
        var stateElement = JsonSerializer.SerializeToElement(state);
        return new VNextWallpaperSync(true, revision, false, stateElement.Clone());
    }

    private static JsonArray SizeRanges(JsonElement overlay)
    {
        var result = new JsonArray();
        foreach (var rule in ObjectArray(overlay, "sizeRanges").Take(20))
        {
            var min = Integer(rule, "min");
            var max = Integer(rule, "max");
            var width = Integer(rule, "width");
            if (min < 1 || max < min || max > 1_000_000 || width < 80 || width > 480) continue;
            result.Add(new JsonObject { ["min"] = min, ["max"] = max, ["width"] = width });
        }
        return result;
    }

    private static JsonNode? Layout(JsonElement row, int canvasWidth, int canvasHeight)
    {
        var missing = int.MinValue;
        var x = Integer(row, "layoutX", missing);
        var y = Integer(row, "layoutY", missing);
        var width = Integer(row, "layoutWidth", missing);
        var height = Integer(row, "layoutHeight", missing);
        if (x < -160 || y < -90 || width < 80 || height < 60
            || (long)x + width > canvasWidth + 160L
            || (long)y + height > canvasHeight + 90L) return null;
        var columns = Integer(row, "layoutColumns", -1);
        var rows = Integer(row, "layoutRows", -1);
        return new JsonObject
        {
            ["x"] = x,
            ["y"] = y,
            ["width"] = width,
            ["height"] = height,
            ["columns"] = columns >= 1 ? JsonValue.Create(columns) : null,
            ["rows"] = rows >= 1 ? JsonValue.Create(rows) : null,
            ["nextSide"] = Text(row, "layoutNextSide", 10) == "left" ? "left" : "right",
            ["layer"] = Integer(row, "layoutLayer", -1) is >= 1 and <= 216
                ? JsonValue.Create(Integer(row, "layoutLayer"))
                : null
        };
    }

    private static void ApplyGrouping(
        JsonObject tile,
        int amount,
        string displayKind,
        IReadOnlyList<(int Min, int Max)> ranges)
    {
        if (displayKind == "challenge_success")
        {
            tile["groupKey"] = $"wallpaper-challenge-success-{amount}";
            tile["mergeRange"] = null;
            return;
        }
        if (displayKind == "subscription")
        {
            tile["groupKey"] = $"wallpaper-subscription-{amount}";
            tile["mergeRange"] = null;
            return;
        }
        var found = ranges.FirstOrDefault(range => amount >= range.Min && amount <= range.Max);
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

    private static IReadOnlyList<(int Min, int Max)> MergeRanges(JsonElement overlay)
    {
        if (!overlay.TryGetProperty("mergeRanges", out var values)
            || values.ValueKind != JsonValueKind.Array) return [];
        return values.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.Object)
            .Select(value => (Min: Integer(value, "min"), Max: Integer(value, "max")))
            .Where(range => range.Min >= 1 && range.Max >= range.Min && range.Max <= 1_000_000)
            .OrderBy(range => range.Min).ThenBy(range => range.Max)
            .Take(20)
            .ToArray();
    }

    private static HashSet<string> VisibleKeys(JsonElement overlay)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!overlay.TryGetProperty("visibleGroupKeys", out var values)
            || values.ValueKind != JsonValueKind.Array) return result;
        foreach (var value in values.EnumerateArray())
        {
            var text = SafeText(value.ValueKind == JsonValueKind.String ? value.GetString() : null, 80);
            if (VisibleKeyPattern().IsMatch(text)) result.Add(text);
            if (result.Count >= 500) break;
        }
        return result;
    }

    private static JsonObject AssetDescriptor(JsonElement asset)
    {
        var result = EmptyAsset();
        var sha256 = Text(asset, "sha256", 64).ToLowerInvariant();
        var mime = Text(asset, "mimeType", 80).ToLowerInvariant();
        var byteSize = Integer(asset, "byteSize");
        var width = Integer(asset, "width");
        var height = Integer(asset, "height");
        result["imageSha256"] = Sha256Pattern().IsMatch(sha256) ? sha256 : null;
        result["imageMimeType"] = mime is "image/png" or "image/jpeg" or "image/webp" or "image/gif" ? mime : null;
        result["imageByteSize"] = byteSize is >= 1 and <= 12 * 1024 * 1024
            ? JsonValue.Create(byteSize) : null;
        result["imageWidth"] = width is >= 1 and <= 4096 ? JsonValue.Create(width) : null;
        result["imageHeight"] = height is >= 1 and <= 4096 ? JsonValue.Create(height) : null;
        return result;
    }

    private static JsonObject EmptyAsset() => new()
    {
        ["imageUrl"] = null,
        ["imageKey"] = null,
        ["source"] = "none",
        ["imageSha256"] = null,
        ["imageMimeType"] = null,
        ["imageByteSize"] = null,
        ["imageWidth"] = null,
        ["imageHeight"] = null
    };

    private static string? NormalizeSoopUrl(object? value)
    {
        var raw = SafeText(value, 2048);
        if (raw.Length == 0) return null;
        try
        {
            var candidate = raw.StartsWith("//", StringComparison.Ordinal)
                ? "https:" + raw
                : raw.StartsWith("/", StringComparison.Ordinal)
                    ? new Uri(new Uri("https://res.sooplive.com"), raw).AbsoluteUri
                    : Regex.Replace(raw, "^http://", "https://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)
                || uri.Scheme != Uri.UriSchemeHttps
                || !uri.IsDefaultPort
                || !string.IsNullOrEmpty(uri.UserInfo)
                || !SoopHosts.Any(root => uri.IdnHost.Equals(root, StringComparison.OrdinalIgnoreCase)
                    || uri.IdnHost.EndsWith("." + root, StringComparison.OrdinalIgnoreCase))) return null;
            var builder = new UriBuilder(uri) { Fragment = "" };
            return builder.Uri.AbsoluteUri;
        }
        catch { return null; }
    }

    private static string DefaultCeremonyUrl(int amount)
    {
        var file = amount <= 50 ? "ba_step2.png"
            : amount <= 100 ? "ba_step3.png"
            : amount <= 500 ? "ba_step4.png"
            : amount <= 1000 ? "ba_step5.png"
            : "ba_step6.png";
        return "https://res.sooplive.com/new_player/items/" + file;
    }

    private static string DisplayKind(JsonElement row) => Text(row, "displayKind", 40) switch
    {
        "challenge_success" => "challenge_success",
        "subscription" => "subscription",
        _ => "donation"
    };

    private static IReadOnlyList<JsonElement> ObjectArray(JsonElement source, string property)
    {
        if (source.ValueKind != JsonValueKind.Object
            || !source.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.Array) return [];
        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Object)
            .Select(item => item.Clone())
            .ToArray();
    }

    private static JsonElement ObjectProperty(JsonElement source, string property)
    {
        if (source.ValueKind == JsonValueKind.Object
            && source.TryGetProperty(property, out var value)
            && value.ValueKind == JsonValueKind.Object) return value;
        return default;
    }

    private static int Integer(JsonElement source, string property, int fallback = 0)
    {
        if (source.ValueKind != JsonValueKind.Object
            || !source.TryGetProperty(property, out var value)) return fallback;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)) return parsed;
        return value.ValueKind == JsonValueKind.String
            && int.TryParse(value.GetString(), out var parsedText) ? parsedText : fallback;
    }

    private static long Integer(JsonElement source, string property, long fallback)
    {
        if (source.ValueKind != JsonValueKind.Object
            || !source.TryGetProperty(property, out var value)) return fallback;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)) return parsed;
        return value.ValueKind == JsonValueKind.String
            && long.TryParse(value.GetString(), out var parsedText) ? parsedText : fallback;
    }

    private static string Text(JsonElement source, string property, int max) =>
        source.ValueKind == JsonValueKind.Object
        && source.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? SafeText(value.GetString(), max)
            : "";

    private static object? Value(JsonElement source, string property) =>
        source.ValueKind == JsonValueKind.Object
        && source.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string SafeText(object? value, int max)
    {
        var clean = new string(
            Convert.ToString(value)?.Select(character => char.IsControl(character) ? ' ' : character).ToArray() ?? [])
            .Trim();
        return clean[..Math.Min(max, clean.Length)];
    }

    private static DateTimeOffset Date(JsonElement source, string property) =>
        DateTimeOffset.TryParse(Text(source, property, 80), out var parsed)
            ? parsed
            : DateTimeOffset.MinValue;

    private static string EncodePath(string path) =>
        string.Join('/', path.Split('/').Select(Uri.EscapeDataString));

    private static InvalidDataException Invalid(string message) => new(message);
}
