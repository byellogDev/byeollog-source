using System.Buffers.Binary;
using System.Text;

namespace HurogiCollector;

internal static class ActionSoundFactory
{
    internal static byte[] CreateEarthquake(int durationMs) => CreateWave(durationMs, (time, state) =>
    {
        var noise = NextNoise(ref state);
        var tremor = Math.Sin(2 * Math.PI * 38 * time) * .34
            + Math.Sin(2 * Math.PI * 57 * time) * .22
            + noise * .18;
        var pulse = .72 + .28 * Math.Sin(2 * Math.PI * 7.5 * time);
        return (Math.Tanh(tremor * pulse * 1.7), state);
    });

    internal static byte[] CreateWaterSplash() => CreateWave(3_500, (time, state) =>
    {
        var noise = NextNoise(ref state);
        var envelope = Math.Exp(-time / .72);
        var rush = noise * envelope * .75;
        var body = Math.Sin(2 * Math.PI * (105 - Math.Min(time * 24, 55)) * time)
            * Math.Exp(-time / .42) * .42;
        var droplets = Math.Sin(2 * Math.PI * 820 * time) * Math.Exp(-time / 1.15) * .08;
        return (Math.Tanh((rush + body + droplets) * 1.25), state);
    });

    internal static byte[] CreateFireworks() => CreateWave(5_000, (time, state) =>
    {
        var noise = NextNoise(ref state);
        var value = 0.0;
        foreach (var burstAt in new[] { .12, .92, 1.66, 2.48, 3.30, 4.05 })
        {
            var age = time - burstAt;
            if (age < 0) continue;
            value += Math.Sin(2 * Math.PI * 72 * age) * Math.Exp(-age / .16) * .44;
            value += noise * Math.Exp(-age / .38) * .34;
        }
        return (Math.Tanh(value * 1.35), state);
    });

    private static byte[] CreateWave(
        int durationMs,
        Func<double, uint, (double Sample, uint State)> generator)
    {
        const int sampleRate = 48_000;
        var sampleCount = checked(sampleRate * durationMs / 1_000);
        var pcmBytes = checked(sampleCount * 2);
        var wave = new byte[44 + pcmBytes];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(wave, 0);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(4, 4), 36 + pcmBytes);
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(wave, 8);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(16, 4), 16);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(20, 2), 1);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(22, 2), 1);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(24, 4), sampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(28, 4), sampleRate * 2);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(32, 2), 2);
        BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(34, 2), 16);
        Encoding.ASCII.GetBytes("data").CopyTo(wave, 36);
        BinaryPrimitives.WriteInt32LittleEndian(wave.AsSpan(40, 4), pcmBytes);

        uint state = 0x9E3779B9u;
        for (var index = 0; index < sampleCount; index++)
        {
            var generated = generator(index / (double)sampleRate, state);
            state = generated.State;
            var endFade = Math.Clamp((sampleCount - index) / (sampleRate * .12), 0, 1);
            var sample = (short)Math.Clamp(
                generated.Sample * endFade * short.MaxValue * .78,
                short.MinValue,
                short.MaxValue);
            BinaryPrimitives.WriteInt16LittleEndian(wave.AsSpan(44 + index * 2, 2), sample);
        }
        return wave;
    }

    private static double NextNoise(ref uint state)
    {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return (state & 0x00FFFFFFu) / 8_388_607.5 - 1.0;
    }
}
