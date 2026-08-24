namespace HurogiCollector;

internal static class VNextSourceIdentity
{
    internal static string RequireValid(string value)
    {
        var sourceUid = value.Trim();
        if (sourceUid.Length == 0)
            throw new InvalidDataException("vNext sourceUid는 비어 있을 수 없습니다.");
        if (sourceUid.Length > 256)
            throw new InvalidDataException("vNext sourceUid는 256자 이하여야 합니다.");
        if (sourceUid.Contains('|') || sourceUid.Any(char.IsControl))
            throw new InvalidDataException("vNext sourceUid에는 제어 문자 또는 | 문자를 사용할 수 없습니다.");
        return sourceUid;
    }
}
