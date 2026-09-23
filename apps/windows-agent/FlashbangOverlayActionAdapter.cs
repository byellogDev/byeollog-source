using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class FlashbangOverlayActionAdapter
{
    internal const string ActionType = "flashbang.overlay";
    internal const int DurationMs = 5_000;
    internal const string AudioBindingKey = "flashbang-blast-v2";

    private static readonly byte[] BeepAudio = CreateBeepWave();
    private static readonly string BeepSha256 = Convert.ToHexString(
        SHA256.HashData(BeepAudio)).ToLowerInvariant();

    private readonly ByeollogOverlayService _overlay;
    private readonly Func<CancellationToken, Task<int>>? _refreshBrowserSources;
    private readonly Func<CancellationToken, Task<bool>>? _ensureBrowserAudioRouting;
    private readonly Action<string>? _log;

    internal FlashbangOverlayActionAdapter(
        ByeollogOverlayService overlay,
        Func<CancellationToken, Task<int>>? refreshBrowserSources = null,
        Func<CancellationToken, Task<bool>>? ensureBrowserAudioRouting = null,
        Action<string>? log = null)
    {
        _overlay = overlay;
        _refreshBrowserSources = refreshBrowserSources;
        _ensureBrowserAudioRouting = ensureBrowserAudioRouting;
        _log = log;
    }

    internal async Task<VNextAgentOutcome> ExecuteAsync(
        JsonElement parameters,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        if (!TryRead(parameters, out var intensity, out var assetKey, out var volumePercent, out var error))
            return new VNextAgentOutcome(false, false, null, error);

        try
        {
            await RefreshCurrentDocumentBestEffortAsync(cancellationToken, notAfterUtc);
            var audio = volumePercent == 0
                ? null
                : new RaffleOverlayAudioContent(
                    BeepAudio,
                    BeepSha256,
                    volumePercent,
                    AudioBindingKey);
            if (audio is not null
                && _ensureBrowserAudioRouting is not null
                && !await RunBeforeDeadlineAsync(_ensureBrowserAudioRouting, cancellationToken, notAfterUtc))
                throw new InvalidOperationException("OBS 브라우저 소스 오디오 라우팅을 준비하지 못했습니다.");

            var shown = await _overlay.ShowObservedAudioTransientAsync(
                assetKey,
                DurationMs,
                new RaffleOverlayPresentation(
                    "flashbang",
                    "",
                    "",
                    "",
                    Array.Empty<string>()),
                placement: null,
                audio,
                cancellationToken,
                notAfterUtc);
            var beepPlayed = audio is null || shown.AudioEvidence.Ended;
            _log?.Invoke(
                $"섬광탄 송출 완료 · intensity={intensity} · volume={volumePercent} · beepPlayed={beepPlayed} · audioFailure={shown.AudioEvidence.FailureType ?? "none"}");
            return new VNextAgentOutcome(true, false, new
            {
                message = "FLASHBANG_OVERLAY_COMPLETED",
                intensity,
                durationMs = DurationMs,
                volumePercent,
                overlayDisplayed = true,
                overlayEvidence = shown.OverlayEvidence,
                beepAttempted = audio is not null,
                beepPlayed,
                audioFailureType = shown.AudioEvidence.FailureType
            }, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (VNextActionExpiredException ex)
        {
            return new VNextAgentOutcome(false, false, null, ex.Message);
        }
        catch (Exception ex)
        {
            return new VNextAgentOutcome(
                false,
                true,
                null,
                "섬광탄 오버레이를 표시하지 못했습니다: " + SafeMessage(ex));
        }
    }

    internal static Task PlayPreviewBeepAsync(
        int volumePercent,
        CancellationToken cancellationToken) =>
        ByeollogRaffleAudio.PlayWavAsync(
            BeepAudio,
            volumePercent,
            cancellationToken);

    internal static bool TryRead(
        JsonElement parameters,
        out string intensity,
        out string assetKey,
        out int volumePercent,
        out string error)
    {
        intensity = "";
        assetKey = "";
        volumePercent = 0;
        error = "섬광탄 설정이 올바르지 않습니다.";
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("intensity", out var intensityValue)
            || intensityValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("overlayImageKey", out var assetValue)
            || assetValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("durationMs", out var durationValue)
            || !durationValue.TryGetInt32(out var durationMs)
            || durationMs != DurationMs
            || !parameters.TryGetProperty("volumePercent", out var volumeValue)
            || !volumeValue.TryGetInt32(out volumePercent)
            || volumePercent is < 0 or > 100)
            return false;

        intensity = intensityValue.GetString()?.Trim() ?? "";
        assetKey = assetValue.GetString()?.Trim() ?? "";
        return (intensity is "soft" or "standard" or "strong")
            && string.Equals(assetKey, AssetKeyForIntensity(intensity), StringComparison.Ordinal);
    }

    internal static string AssetKeyForIntensity(string intensity) => intensity switch
    {
        "soft" => OverlayAssetCache.FlashbangSoftAssetKey,
        "standard" => OverlayAssetCache.FlashbangStandardAssetKey,
        "strong" => OverlayAssetCache.FlashbangStrongAssetKey,
        _ => ""
    };

    private async Task RefreshCurrentDocumentBestEffortAsync(
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        if (_refreshBrowserSources is null) return;
        try
        {
            _ = await RunBeforeDeadlineAsync(_refreshBrowserSources, cancellationToken, notAfterUtc);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (
            notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
        {
            throw new VNextActionExpiredException();
        }
        catch (Exception ex)
        {
            // ShowObservedAudioTransientAsync still requires a current-document
            // active poll before any sound starts, so refresh failure remains
            // fail-closed without hiding a potentially healthy Browser Source.
            _log?.Invoke("섬광탄 OBS 새로고침 보류 · type=" + ex.GetType().Name);
        }
    }

    private static async Task<T> RunBeforeDeadlineAsync<T>(
        Func<CancellationToken, Task<T>> action,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (notAfterUtc is not null)
        {
            var remaining = notAfterUtc.Value - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) throw new VNextActionExpiredException();
            deadline.CancelAfter(remaining);
        }
        try
        {
            return await action(deadline.Token);
        }
        catch (OperationCanceledException) when (
            !cancellationToken.IsCancellationRequested
            && notAfterUtc is not null
            && DateTimeOffset.UtcNow >= notAfterUtc.Value)
        {
            throw new VNextActionExpiredException();
        }
    }

    private static byte[] CreateBeepWave()
    {
        const int sampleRate = 48_000;
        const double durationSeconds = 5.0;
        var sampleCount = checked((int)(sampleRate * durationSeconds));
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

        uint noiseState = 0x6A09E667u;
        double lowNoise = 0.0;
        for (var index = 0; index < sampleCount; index++)
        {
            var time = index / (double)sampleRate;

            // One restrained broadband impact is followed by a fixed tinnitus
            // ring. Keep the pitch stationary so it never reads as a siren.
            noiseState ^= noiseState << 13;
            noiseState ^= noiseState >> 17;
            noiseState ^= noiseState << 5;
            var whiteNoise = ((noiseState & 0x00FFFFFFu) / 8_388_607.5) - 1.0;
            lowNoise += 0.045 * (whiteNoise - lowNoise);

            var blastEnvelope = Math.Exp(-time / 0.055);
            var blast = whiteNoise * blastEnvelope
                + lowNoise * Math.Exp(-time / 0.22) * 0.9
                + Math.Sin(2.0 * Math.PI * 92.0 * time) * Math.Exp(-time / 0.16) * 0.65;

            var ringAttack = Math.Min(1.0, time / 0.018);
            var ringDecay = Math.Exp(-time / 2.65);
            var endFade = Math.Clamp((durationSeconds - time) / 0.55, 0.0, 1.0);
            var ringEnvelope = ringAttack * ringDecay * endFade;
            var amplitudeFlutter = 0.94 + 0.06 * Math.Sin(2.0 * Math.PI * 3.2 * time);
            const double ringFrequency = 3_560.0;
            var ring = Math.Sin(2.0 * Math.PI * ringFrequency * time)
                + 0.24 * Math.Sin(2.0 * Math.PI * ringFrequency * 2.0 * time)
                + 0.09 * Math.Sin(2.0 * Math.PI * ringFrequency * 3.0 * time);
            var residualHiss = whiteNoise * Math.Exp(-time / 0.72) * endFade;

            var mixed = blast * 0.31
                + ring * ringEnvelope * amplitudeFlutter * 0.40
                + residualHiss * 0.06;
            var tone = Math.Tanh(mixed * 1.18) / Math.Tanh(1.18);
            var sample = (short)Math.Clamp(
                tone * short.MaxValue * 0.82,
                short.MinValue,
                short.MaxValue);
            BinaryPrimitives.WriteInt16LittleEndian(
                wave.AsSpan(44 + index * 2, 2),
                sample);
        }
        return wave;
    }

    private static string SafeMessage(Exception ex)
    {
        var message = (ex.Message ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length == 0 ? ex.GetType().Name : message[..Math.Min(message.Length, 180)];
    }
}
