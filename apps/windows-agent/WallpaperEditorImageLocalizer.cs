using System.Text.Json.Nodes;

namespace HurogiCollector;

internal static class WallpaperEditorImageLocalizer
{
    internal static void Replace(
        JsonNode? node,
        IReadOnlyDictionary<string, string> byId,
        IReadOnlyDictionary<string, string> byImageKey)
    {
        if (node is JsonObject obj)
        {
            var id = obj["id"]?.GetValue<string?>();
            var imageKey = obj["imageKey"]?.GetValue<string?>();
            if (obj.ContainsKey("imageUrl"))
            {
                if (id is not null && byId.TryGetValue(id, out var urlById))
                    obj["imageUrl"] = urlById;
                else if (imageKey is not null && byImageKey.TryGetValue(imageKey, out var urlByKey))
                    obj["imageUrl"] = urlByKey;
            }
            foreach (var item in obj.ToArray()) Replace(item.Value, byId, byImageKey);
        }
        else if (node is JsonArray array)
            foreach (var item in array) Replace(item, byId, byImageKey);
    }
}
