using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HurogiCollector;

internal enum VNextActionFreshnessStatus
{
    Fresh,
    Expired,
    Invalid
}

internal static class VNextActionFreshness
{
    private static readonly Regex IsoUtcPattern = new(
        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?(?:Z|[+-]\\d{2}:\\d{2})$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static VNextActionFreshnessStatus ValidateAndStrip(
        JsonElement parameters,
        DateTimeOffset nowUtc,
        out JsonElement actionParameters,
        out string error) =>
        ValidateAndStrip(parameters, nowUtc, out actionParameters, out _, out error);

    public static VNextActionFreshnessStatus ValidateAndStrip(
        JsonElement parameters,
        DateTimeOffset nowUtc,
        out JsonElement actionParameters,
        out DateTimeOffset? notAfterUtc,
        out string error)
    {
        actionParameters = parameters.Clone();
        notAfterUtc = null;
        error = "";
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            error = "로컬 액션 매개변수가 올바르지 않습니다.";
            return VNextActionFreshnessStatus.Invalid;
        }

        JsonElement notAfterValue = default;
        var notAfterCount = 0;
        foreach (var property in parameters.EnumerateObject())
        {
            if (!string.Equals(property.Name, "notAfterUtc", StringComparison.Ordinal)) continue;
            notAfterCount++;
            notAfterValue = property.Value;
        }
        if (notAfterCount == 0)
            return VNextActionFreshnessStatus.Fresh;
        if (notAfterCount != 1
            || notAfterValue.ValueKind != JsonValueKind.String)
        {
            error = "로컬 액션 만료 시각이 올바르지 않습니다.";
            return VNextActionFreshnessStatus.Invalid;
        }

        var text = notAfterValue.GetString() ?? "";
        if (!IsoUtcPattern.IsMatch(text)
            || !DateTimeOffset.TryParse(
                text,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var parsedNotAfterUtc))
        {
            error = "로컬 액션 만료 시각이 올바르지 않습니다.";
            return VNextActionFreshnessStatus.Invalid;
        }
        notAfterUtc = parsedNotAfterUtc.ToUniversalTime();

        using (var buffer = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                foreach (var property in parameters.EnumerateObject())
                {
                    if (string.Equals(property.Name, "notAfterUtc", StringComparison.Ordinal)) continue;
                    property.WriteTo(writer);
                }
                writer.WriteEndObject();
            }
            using var stripped = JsonDocument.Parse(buffer.ToArray());
            actionParameters = stripped.RootElement.Clone();
        }

        if (notAfterUtc <= nowUtc.ToUniversalTime())
        {
            error = "실행 가능 시간이 지난 로컬 액션이라 안전하게 차단했습니다.";
            return VNextActionFreshnessStatus.Expired;
        }
        return VNextActionFreshnessStatus.Fresh;
    }
}

internal sealed class VNextActionExpiredException : InvalidOperationException
{
    public VNextActionExpiredException()
        : base("실행 가능 시간이 지난 로컬 액션이라 안전하게 차단했습니다.") { }
}
