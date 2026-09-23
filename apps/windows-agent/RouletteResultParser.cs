namespace HurogiCollector;

internal sealed record RouletteSpinParseResult(int SpinCount, IReadOnlyList<string> Results);

internal static class RouletteResultParser
{
    internal static IReadOnlyList<string> Split(string? rawResult)
    {
        if (string.IsNullOrWhiteSpace(rawResult)) return Array.Empty<string>();

        return rawResult
            .Split('&', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(segment => segment.Length > 0)
            .ToArray();
    }

    internal static RouletteSpinParseResult ParseSpins(IEnumerable<string?> rawResults)
    {
        var spinCount = 0;
        var results = new List<string>();

        foreach (var rawResult in rawResults)
        {
            var segments = Split(rawResult);
            if (segments.Count == 0) continue;

            // A single roulette spin may award multiple independently stored results
            // (for example, "A 단컷 & A 움짤"). Keep the spin count separate from
            // the flattened reward count so validation still compares paid spins.
            spinCount++;
            results.AddRange(segments);
        }

        return new RouletteSpinParseResult(spinCount, results);
    }

    internal static string ValidateSpinCount(int expectedSpins, int actualSpins)
    {
        if (expectedSpins <= 0) throw new ArgumentOutOfRangeException(nameof(expectedSpins));
        if (actualSpins < 0) throw new ArgumentOutOfRangeException(nameof(actualSpins));

        return actualSpins == expectedSpins
            ? "matched"
            : actualSpins < expectedSpins ? "short" : "over";
    }
}
