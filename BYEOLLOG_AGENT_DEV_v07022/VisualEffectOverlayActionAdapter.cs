using System.Security.Cryptography;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class VisualEffectOverlayActionAdapter
{
    internal const string WaterActionType = "water_splash.overlay";
    internal const string FireworksActionType = "fireworks.overlay";
    internal const int WaterDurationMs = 3_500;
    internal const int FireworksDurationMs = 5_000;

    private static readonly byte[] WaterAudio = ActionSoundFactory.CreateWaterSplash();
    private static readonly byte[] FireworksAudio = ActionSoundFactory.CreateFireworks();
    private static readonly string WaterAudioSha = Hash(WaterAudio);
    private static readonly string FireworksAudioSha = Hash(FireworksAudio);
    private readonly ByeollogOverlayService _overlay;
    private readonly Func<CancellationToken, Task<int>>? _refreshBrowserSources;
    private readonly Func<CancellationToken, Task<bool>>? _ensureBrowserAudioRouting;
    private readonly Action<string>? _log;

    internal VisualEffectOverlayActionAdapter(
        ByeollogOverlayService overlay,
        Func<CancellationToken, Task<int>>? refreshBrowserSources,
        Func<CancellationToken, Task<bool>>? ensureBrowserAudioRouting,
        Action<string>? log)
    {
        _overlay = overlay;
        _refreshBrowserSources = refreshBrowserSources;
        _ensureBrowserAudioRouting = ensureBrowserAudioRouting;
        _log = log;
    }

    internal async Task<VNextAgentOutcome> ExecuteAsync(
        string actionType,
        JsonElement parameters,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        if (!TryRead(actionType, parameters, out var effect, out var assetKey,
                out var durationMs, out var volumePercent, out var error))
            return new VNextAgentOutcome(false, false, null, error);
        try
        {
            if (_refreshBrowserSources is not null)
            {
                try { _ = await _refreshBrowserSources(cancellationToken); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _log?.Invoke("이펙트 오버레이 새로고침 보류 · type=" + ex.GetType().Name);
                }
            }
            if (volumePercent > 0
                && (_ensureBrowserAudioRouting is null
                    || !await _ensureBrowserAudioRouting(cancellationToken)))
                throw new InvalidOperationException("OBS 브라우저 소스 오디오 라우팅을 준비하지 못했습니다.");

            var bytes = effect == "water_splash" ? WaterAudio : FireworksAudio;
            var sha = effect == "water_splash" ? WaterAudioSha : FireworksAudioSha;
            var shown = await _overlay.ShowObservedAudioTransientAsync(
                assetKey,
                durationMs,
                new RaffleOverlayPresentation(effect, "", "", "", Array.Empty<string>()),
                null,
                volumePercent == 0 ? null : new RaffleOverlayAudioContent(
                    bytes,
                    sha,
                    volumePercent,
                    effect + "-audio-v1"),
                cancellationToken,
                notAfterUtc);
            return new VNextAgentOutcome(true, false, new
            {
                message = effect == "water_splash"
                    ? "WATER_SPLASH_COMPLETED"
                    : "FIREWORKS_COMPLETED",
                effect,
                durationMs,
                volumePercent,
                overlayDisplayed = true,
                overlayEvidence = shown.OverlayEvidence,
                audioPlayed = volumePercent == 0 || shown.AudioEvidence.Ended,
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
            return new VNextAgentOutcome(false, true, null,
                "이펙트 액션을 표시하지 못했습니다: " + SafeMessage(ex));
        }
    }

    internal static Task PlayPreviewAsync(
        string effect,
        int volumePercent,
        CancellationToken cancellationToken) =>
        ByeollogRaffleAudio.PlayWavAsync(
            effect == "water_splash" ? WaterAudio : FireworksAudio,
            volumePercent,
            cancellationToken);

    internal static bool TryRead(
        string actionType,
        JsonElement parameters,
        out string effect,
        out string assetKey,
        out int durationMs,
        out int volumePercent,
        out string error)
    {
        effect = "";
        assetKey = "";
        durationMs = 0;
        volumePercent = 0;
        error = "이펙트 액션 설정이 올바르지 않습니다.";
        if (parameters.ValueKind != JsonValueKind.Object
            || parameters.EnumerateObject().Count() != 6
            || !parameters.TryGetProperty("label", out var labelValue)
            || labelValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("controlType", out var controlValue)
            || controlValue.GetString() != "overlay_effect"
            || !parameters.TryGetProperty("effect", out var effectValue)
            || effectValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("overlayImageKey", out var assetValue)
            || assetValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("durationMs", out var durationValue)
            || !durationValue.TryGetInt32(out durationMs)
            || !parameters.TryGetProperty("volumePercent", out var volumeValue)
            || !volumeValue.TryGetInt32(out volumePercent)
            || volumePercent is < 0 or > 100)
            return false;
        effect = effectValue.GetString() ?? "";
        assetKey = assetValue.GetString() ?? "";
        return actionType switch
        {
            WaterActionType => effect == "water_splash"
                && labelValue.GetString() == "물벼락"
                && assetKey == OverlayAssetCache.WaterSplashAssetKey
                && durationMs == WaterDurationMs,
            FireworksActionType => effect == "fireworks"
                && labelValue.GetString() == "축포"
                && assetKey == OverlayAssetCache.FireworksAssetKey
                && durationMs == FireworksDurationMs,
            _ => false
        };
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string SafeMessage(Exception ex)
    {
        var message = (ex.Message ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length == 0 ? ex.GetType().Name : message[..Math.Min(message.Length, 180)];
    }
}
