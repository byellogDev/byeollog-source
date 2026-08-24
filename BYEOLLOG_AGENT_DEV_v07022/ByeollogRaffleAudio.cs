using System.Security.Cryptography;
using NAudio.Wave;

namespace HurogiCollector;

internal static class ByeollogRaffleAudio
{
    internal const string TicketResourceName =
        "HurogiCollector.Assets.byeollog_raffle_ticket_fixed.wav";
    internal const int TicketByteSize = 139_928;
    internal const string TicketSha256 =
        "e0e1df2d38eacf60beed552fb5635f5e34282ba49b909e7b326ed76cd09f6811";
    internal const string WinnerPreviewResourceName =
        "HurogiCollector.Assets.byeollog_raffle_winner_preview.wav";
    internal const int WinnerPreviewByteSize = 280_052;
    internal const string WinnerPreviewSha256 =
        "7d19fb4dbf0a89f99ca0de0c279f802a322e25fc23cc6e1468a90a7bc681eb6b";
    internal const string WinnerFallbackResourceName =
        "HurogiCollector.Assets.byeollog_raffle_winner_fallback.wav";
    internal const int WinnerFallbackByteSize = 80_684;
    internal const string WinnerFallbackSha256 =
        "ea566cc2bd872fad7d75684a9ce47ec3486c8d8fe50b3002ab470bbd9c536dea";
    internal const string WinnerFallbackVoiceVersion =
        "byeollog-embedded-winner-fallback-v1";
    internal const string WinnerFallbackSpeechText = "당첨을 축하드려요";
    internal const int MaximumWinnerAudioBytes = 2 * 1024 * 1024;

    private static readonly SemaphoreSlim PlaybackGate = new(1, 1);
    private static readonly Lazy<byte[]> TicketAudio = new(LoadAndVerifyTicketAudio);
    private static readonly Lazy<byte[]> WinnerPreviewAudio = new(LoadAndVerifyWinnerPreviewAudio);
    private static readonly Lazy<byte[]> WinnerFallbackAudio = new(LoadAndVerifyWinnerFallbackAudio);

    internal static Task PlayTicketAsync(
        int volumePercent,
        CancellationToken cancellationToken) =>
        PlayWavAsync(TicketAudio.Value, volumePercent, cancellationToken);

    internal static Task PlayWinnerAsync(
        byte[] audio,
        int volumePercent,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(audio);
        if (audio.Length is < 44 or > MaximumWinnerAudioBytes)
            throw new InvalidDataException("당첨 음성 응답 크기가 올바르지 않습니다.");
        return PlayWavAsync(audio, volumePercent, cancellationToken);
    }

    internal static Task PlayWinnerPreviewAsync(
        int volumePercent,
        CancellationToken cancellationToken) =>
        PlayWavAsync(WinnerPreviewAudio.Value, volumePercent, cancellationToken);

    internal static byte[] TicketAudioForPreflight() =>
        TicketAudio.Value.ToArray();

    internal static byte[] WinnerPreviewAudioForPreflight() =>
        WinnerPreviewAudio.Value.ToArray();

    internal static byte[] WinnerFallbackAudioForPreflight() =>
        WinnerFallbackAudio.Value.ToArray();

    internal static void ValidateWinnerAudioForPreflight(byte[] audio) =>
        ValidateWav(audio, MaximumWinnerAudioBytes);

    private static byte[] LoadAndVerifyTicketAudio()
        => LoadAndVerifyEmbeddedAudio(
            TicketResourceName,
            TicketByteSize,
            TicketSha256,
            "내장 추첨권 음성");

    private static byte[] LoadAndVerifyWinnerPreviewAudio()
        => LoadAndVerifyEmbeddedAudio(
            WinnerPreviewResourceName,
            WinnerPreviewByteSize,
            WinnerPreviewSha256,
            "내장 당첨 미리듣기 음성");

    private static byte[] LoadAndVerifyWinnerFallbackAudio()
        => LoadAndVerifyEmbeddedAudio(
            WinnerFallbackResourceName,
            WinnerFallbackByteSize,
            WinnerFallbackSha256,
            "내장 당첨 예비 음성");

    private static byte[] LoadAndVerifyEmbeddedAudio(
        string resourceName,
        int expectedByteSize,
        string expectedSha256,
        string displayName)
    {
        using var resource = typeof(ByeollogRaffleAudio).Assembly
            .GetManifestResourceStream(resourceName)
            ?? throw new InvalidDataException($"{displayName}을 찾지 못했습니다.");
        using var memory = new MemoryStream(expectedByteSize);
        resource.CopyTo(memory);
        var bytes = memory.ToArray();
        if (bytes.Length != expectedByteSize
            || !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(bytes),
                Convert.FromHexString(expectedSha256)))
            throw new InvalidDataException($"{displayName}의 무결성이 올바르지 않습니다.");
        ValidateWav(bytes, expectedByteSize);
        return bytes;
    }

    internal static async Task PlayWavAsync(
        byte[] audio,
        int volumePercent,
        CancellationToken cancellationToken)
    {
        if (volumePercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(volumePercent));
        if (volumePercent == 0) return;

        ValidateWav(audio, Math.Max(TicketByteSize, MaximumWinnerAudioBytes));
        await PlaybackGate.WaitAsync(cancellationToken);
        try
        {
            using var stream = new MemoryStream(audio, writable: false);
            using var reader = new WaveFileReader(stream);
            using var output = new WaveOutEvent
            {
                DesiredLatency = 120,
                NumberOfBuffers = 3,
                Volume = volumePercent / 100f
            };
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            output.PlaybackStopped += (_, args) =>
            {
                if (args.Exception is not null) completion.TrySetException(args.Exception);
                else completion.TrySetResult();
            };
            output.Init(reader);
            using var registration = cancellationToken.Register(() =>
            {
                try { output.Stop(); } catch { }
                completion.TrySetCanceled(cancellationToken);
            });
            output.Play();
            await completion.Task;
        }
        finally
        {
            PlaybackGate.Release();
        }
    }

    private static void ValidateWav(byte[] audio, int maximumBytes)
    {
        if (audio.Length is < 44 || audio.Length > maximumBytes
            || audio[0] != (byte)'R' || audio[1] != (byte)'I'
            || audio[2] != (byte)'F' || audio[3] != (byte)'F'
            || audio[8] != (byte)'W' || audio[9] != (byte)'A'
            || audio[10] != (byte)'V' || audio[11] != (byte)'E')
            throw new InvalidDataException("음성 응답이 WAV 형식이 아닙니다.");

        using var stream = new MemoryStream(audio, writable: false);
        using var reader = new WaveFileReader(stream);
        if (reader.WaveFormat.SampleRate is < 16_000 or > 48_000
            || reader.WaveFormat.Channels is < 1 or > 2
            || reader.TotalTime <= TimeSpan.Zero
            || reader.TotalTime > TimeSpan.FromSeconds(20))
            throw new InvalidDataException("음성 응답의 재생 형식이 올바르지 않습니다.");
    }
}
