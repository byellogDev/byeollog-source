using System.Text.Json;

namespace HurogiCollector;

internal static class WeflabTrialProtocol
{
    internal static object Assess(string raw, int count)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw); var r = doc.RootElement;
            if (Text(r, "result") != "success") return new { status = "needs_review", reason = "result_error" };
            var api = Text(r, "api");
            if (api is not ("sql" or "mem")) return new { status = "needs_review", reason = "possible_result_generation", api };
            var values = new List<string>();
            if (r.TryGetProperty("list", out var list) && list.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(list.GetString()))
            { using var parsed = JsonDocument.Parse(list.GetString()!); list = parsed.RootElement.Clone(); }
            if (list.ValueKind == JsonValueKind.Array && list.GetArrayLength() > 0)
                foreach (var item in list.EnumerateArray()) values.Add(item[0].GetString()!);
            else values.Add(r.GetProperty("data").GetString()!);
            if (values.Count != count || values.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 2048)) return new { status = "needs_review", reason = "result_count_or_shape" };
            return new { status = "stored_result_observed", api, results = values };
        }
        catch { return new { status = "needs_review", reason = "result_schema" }; }
    }
    internal static string Text(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null ? v.ToString() : "";

}
