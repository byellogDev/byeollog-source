using System.Buffers.Binary;
using System.Reflection;

namespace HurogiCollector;

internal static class ActionSoundFactory
{
    private const string EarthquakeResourceName =
        "HurogiCollector.Assets.byeollog_earthquake_natural.wav";
    private const string WaterResourceName =
        "HurogiCollector.Assets.byeollog_water_splash_natural.wav";
    private const string PartyPopperResourceName =
        "HurogiCollector.Assets.byeollog_party_popper_natural.wav";

    private static readonly byte[] Earthquake = ReadEmbedded(EarthquakeResourceName);
    private static readonly byte[] Water = ReadEmbedded(WaterResourceName);
    private static readonly byte[] PartyPopper = ReadEmbedded(PartyPopperResourceName);

    internal static byte[] CreateEarthquake(int durationMs)
    {
        if (durationMs is < 2_000 or > 10_000 || durationMs % 1_000 != 0)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        return TrimPcm16Wave(Earthquake, durationMs, fadeOutMs: 180);
    }

    internal static byte[] CreateWaterSplash() => Water.ToArray();

    internal static byte[] CreateFireworks() => PartyPopper.ToArray();

    private static byte[] TrimPcm16Wave(byte[] source, int durationMs, int fadeOutMs)
    {
        if (source.Length < 44
            || !source.AsSpan(0, 4).SequenceEqual("RIFF"u8)
            || !source.AsSpan(8, 4).SequenceEqual("WAVE"u8)
            || !source.AsSpan(12, 4).SequenceEqual("fmt "u8)
            || BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(20, 2)) != 1
            || BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(34, 2)) != 16
            || !source.AsSpan(36, 4).SequenceEqual("data"u8))
            throw new InvalidDataException("내장 자연음 WAV 형식이 올바르지 않습니다.");

        var channels = BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(22, 2));
        var sampleRate = BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(24, 4));
        var blockAlign = BinaryPrimitives.ReadInt16LittleEndian(source.AsSpan(32, 2));
        if (channels is < 1 or > 2 || sampleRate != 48_000 || blockAlign != channels * 2)
            throw new InvalidDataException("내장 자연음 WAV 채널 정보가 올바르지 않습니다.");

        var availableBytes = Math.Min(
            BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(40, 4)),
            source.Length - 44);
        var requestedBytes = checked(sampleRate * blockAlign * durationMs / 1_000);
        if (requestedBytes > availableBytes)
            throw new InvalidDataException("내장 지진 자연음 길이가 부족합니다.");

        var result = new byte[44 + requestedBytes];
        source.AsSpan(0, 44).CopyTo(result);
        source.AsSpan(44, requestedBytes).CopyTo(result.AsSpan(44));
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(4, 4), 36 + requestedBytes);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(40, 4), requestedBytes);

        var fadeFrames = Math.Min(sampleRate * fadeOutMs / 1_000, requestedBytes / blockAlign);
        var totalFrames = requestedBytes / blockAlign;
        for (var frame = 0; frame < fadeFrames; frame++)
        {
            var gain = (fadeFrames - frame - 1) / (double)fadeFrames;
            var frameIndex = totalFrames - fadeFrames + frame;
            for (var channel = 0; channel < channels; channel++)
            {
                var offset = 44 + frameIndex * blockAlign + channel * 2;
                var sample = BinaryPrimitives.ReadInt16LittleEndian(result.AsSpan(offset, 2));
                BinaryPrimitives.WriteInt16LittleEndian(
                    result.AsSpan(offset, 2),
                    (short)Math.Clamp(Math.Round(sample * gain), short.MinValue, short.MaxValue));
            }
        }
        return result;
    }

    private static byte[] ReadEmbedded(string resourceName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("내장 자연음 파일을 찾지 못했습니다.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }
}
