using System.Security.Cryptography;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class ScreenActionAdapter
{
    internal const string FlipActionType = "obs.screen_flip_for";
    internal const string ShakeActionType = "obs.screen_shake_for";
    internal const string EarthquakeAssetKey = "earthquake_audio";
    private const string TemporaryScenePrefix = "별록 화면 액션 ";
    private readonly CollectorStorage _storage;
    private readonly ByeollogOverlayService _overlay;
    private readonly Func<CancellationToken, Task<bool>>? _ensureBrowserAudioRouting;
    private readonly Action<string>? _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal ScreenActionAdapter(
        CollectorStorage storage,
        ByeollogOverlayService overlay,
        Func<CancellationToken, Task<bool>>? ensureBrowserAudioRouting = null,
        Action<string>? log = null)
    {
        _storage = storage;
        _overlay = overlay;
        _ensureBrowserAudioRouting = ensureBrowserAudioRouting;
        _log = log;
    }

    internal async Task<VNextAgentOutcome> ExecuteAsync(
        string actionType,
        JsonElement parameters,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        if (!TryRead(actionType, parameters, out var durationMs, out var intensity,
                out var volumePercent, out var error))
            return new VNextAgentOutcome(false, false, null, error);

        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled)
            return new VNextAgentOutcome(false, false, null, "OBS 연결이 꺼져 있습니다.");

        await WaitBeforeDeadlineAsync(_gate, cancellationToken, notAfterUtc);
        string? temporarySceneUuid = null;
        string? originalSceneUuid = null;
        var restored = false;
        var activated = false;
        try
        {
            await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
            var info = await obs.GetVersionAsync(cancellationToken);
            RequireRequests(info);
            await RecoverStaleTemporaryScenesAsync(obs, cancellationToken);

            var original = await obs.GetCurrentProgramSceneAsync(cancellationToken);
            var video = await obs.GetVideoSettingsAsync(cancellationToken);
            originalSceneUuid = original.SceneUuid;
            var temporaryName = TemporaryScenePrefix + original.SceneUuid;
            temporarySceneUuid = await obs.CreateSceneAsync(temporaryName, cancellationToken);
            var sceneItemId = await obs.CreateSceneItemAsync(
                temporarySceneUuid,
                original.SceneUuid,
                cancellationToken);

            if (actionType == FlipActionType)
            {
                await obs.SetSceneItemTransformAsync(
                    temporarySceneUuid,
                    sceneItemId,
                    new
                    {
                        alignment = 5,
                        positionX = 0.0,
                        positionY = (double)video.BaseHeight,
                        scaleX = 1.0,
                        scaleY = -1.0,
                        rotation = 0.0
                    },
                    cancellationToken);
            }
            else
            {
                var overscan = intensity switch { "soft" => 1.025, "strong" => 1.065, _ => 1.045 };
                await obs.SetSceneItemTransformAsync(
                    temporarySceneUuid,
                    sceneItemId,
                    new
                    {
                        alignment = 5,
                        positionX = -video.BaseWidth * (overscan - 1) / 2,
                        positionY = -video.BaseHeight * (overscan - 1) / 2,
                        scaleX = overscan,
                        scaleY = overscan,
                        rotation = 0.0
                    },
                    cancellationToken);
            }

            await obs.SetCurrentProgramSceneAsync(temporarySceneUuid, cancellationToken);
            activated = true;
            Task? soundTask = null;
            if (actionType == ShakeActionType && volumePercent > 0)
            {
                if (_ensureBrowserAudioRouting is null
                    || !await _ensureBrowserAudioRouting(cancellationToken))
                    throw new InvalidOperationException("OBS 브라우저 소스 오디오 라우팅을 준비하지 못했습니다.");
                var audioBytes = ActionSoundFactory.CreateEarthquake(durationMs);
                soundTask = _overlay.ShowObservedAudioTransientAsync(
                    EarthquakeAssetKey,
                    durationMs,
                    new RaffleOverlayPresentation("earthquake", "", "", "", Array.Empty<string>()),
                    null,
                    new RaffleOverlayAudioContent(
                        audioBytes,
                        Convert.ToHexString(SHA256.HashData(audioBytes)).ToLowerInvariant(),
                        volumePercent,
                        "earthquake-natural-rumble-v2"),
                    cancellationToken,
                    notAfterUtc);
            }

            if (actionType == FlipActionType)
                await Task.Delay(durationMs, cancellationToken);
            else
                await RunShakeAsync(obs, temporarySceneUuid, sceneItemId, video, intensity, durationMs, cancellationToken);
            if (soundTask is not null) await soundTask;

            restored = await RestoreAndRemoveAsync(
                settings,
                obs,
                originalSceneUuid,
                temporarySceneUuid,
                CancellationToken.None);
            temporarySceneUuid = null;
            return new VNextAgentOutcome(true, false, new
            {
                message = actionType == FlipActionType
                    ? "SCREEN_FLIP_COMPLETED"
                    : "SCREEN_SHAKE_COMPLETED",
                durationMs,
                intensity = actionType == ShakeActionType ? intensity : null,
                volumePercent = actionType == ShakeActionType ? (int?)volumePercent : null,
                restored
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
                !activated,
                null,
                "화면 액션을 완료하지 못했습니다: " + SafeMessage(ex));
        }
        finally
        {
            if (temporarySceneUuid is not null && originalSceneUuid is not null)
            {
                using var restoreTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                try
                {
                    restored = await RestoreAndRemoveAsync(
                        settings,
                        existing: null,
                        originalSceneUuid,
                        temporarySceneUuid,
                        restoreTimeout.Token);
                }
                catch (Exception ex)
                {
                    _log?.Invoke("화면 액션 원복 재시도 실패 · type=" + ex.GetType().Name);
                }
            }
            _gate.Release();
        }
    }

    internal async Task RecoverStaleAsync(CancellationToken cancellationToken)
    {
        var settings = _storage.LoadObsSettings();
        if (!settings.Enabled) return;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var obs = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
            await RecoverStaleTemporaryScenesAsync(obs, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task RunShakeAsync(
        ObsWebSocketClient obs,
        string sceneUuid,
        int sceneItemId,
        ObsVideoSettings video,
        string intensity,
        int durationMs,
        CancellationToken cancellationToken)
    {
        var overscan = intensity switch { "soft" => 1.025, "strong" => 1.065, _ => 1.045 };
        var amplitude = intensity switch { "soft" => 8.0, "strong" => 24.0, _ => 15.0 };
        var originX = -video.BaseWidth * (overscan - 1) / 2;
        var originY = -video.BaseHeight * (overscan - 1) / 2;
        var started = Environment.TickCount64;
        var frame = 0;
        while (Environment.TickCount64 - started < durationMs)
        {
            var phase = frame * 1.87;
            var x = originX + Math.Sin(phase) * amplitude + Math.Sin(phase * .43) * amplitude * .35;
            var y = originY + Math.Cos(phase * 1.31) * amplitude * .72;
            var rotation = Math.Sin(phase * .59) * (intensity == "strong" ? .75 : .38);
            await obs.SetSceneItemTransformAsync(
                sceneUuid,
                sceneItemId,
                new { alignment = 5, positionX = x, positionY = y, scaleX = overscan, scaleY = overscan, rotation },
                cancellationToken);
            frame++;
            await Task.Delay(50, cancellationToken);
        }
    }

    private async Task RecoverStaleTemporaryScenesAsync(
        ObsWebSocketClient obs,
        CancellationToken cancellationToken)
    {
        var current = await obs.GetCurrentProgramSceneAsync(cancellationToken);
        var scenes = await obs.GetSceneListAsync(cancellationToken);
        foreach (var scene in scenes.Where(item =>
                     item.SceneName.StartsWith(TemporaryScenePrefix, StringComparison.Ordinal)))
        {
            var encoded = scene.SceneName[TemporaryScenePrefix.Length..];
            if (!Guid.TryParse(encoded, out _)) continue;
            if (string.Equals(current.SceneUuid, scene.SceneUuid, StringComparison.OrdinalIgnoreCase))
                await obs.SetCurrentProgramSceneAsync(encoded, cancellationToken);
            await obs.RemoveSceneAsync(scene.SceneUuid, cancellationToken);
            _log?.Invoke("이전 화면 액션 임시 장면을 안전하게 정리했습니다.");
        }
    }

    private static async Task<bool> RestoreAndRemoveAsync(
        ObsConnectionSettings settings,
        ObsWebSocketClient? existing,
        string originalSceneUuid,
        string temporarySceneUuid,
        CancellationToken cancellationToken)
    {
        ObsWebSocketClient? owned = null;
        var obs = existing;
        try
        {
            obs ??= owned = await ObsWebSocketClient.ConnectAsync(settings, cancellationToken);
            var current = await obs.GetCurrentProgramSceneAsync(cancellationToken);
            if (string.Equals(current.SceneUuid, temporarySceneUuid, StringComparison.OrdinalIgnoreCase))
                await obs.SetCurrentProgramSceneAsync(originalSceneUuid, cancellationToken);
            current = await obs.GetCurrentProgramSceneAsync(cancellationToken);
            if (!string.Equals(current.SceneUuid, temporarySceneUuid, StringComparison.OrdinalIgnoreCase))
                await obs.RemoveSceneAsync(temporarySceneUuid, cancellationToken);
            return true;
        }
        finally
        {
            if (owned is not null) await owned.DisposeAsync();
        }
    }

    private static bool TryRead(
        string actionType,
        JsonElement parameters,
        out int durationMs,
        out string intensity,
        out int volumePercent,
        out string error)
    {
        durationMs = 0;
        intensity = "";
        volumePercent = 0;
        error = "화면 액션 설정이 올바르지 않습니다.";
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("label", out var label)
            || label.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("controlType", out var controlType)
            || controlType.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("target", out var target)
            || target.GetString() != "program"
            || !parameters.TryGetProperty("durationMs", out var duration)
            || !duration.TryGetInt32(out durationMs)
            || durationMs % 1000 != 0
            || !parameters.TryGetProperty("requiresObsSceneControl", out var required)
            || required.ValueKind != JsonValueKind.True)
            return false;
        if (actionType == FlipActionType)
            return parameters.EnumerateObject().Count() == 7
                && label.GetString() == "화면 뒤집기"
                && controlType.GetString() == "screen_flip"
                && durationMs is >= 3_000 and <= 30_000
                && parameters.TryGetProperty("axis", out var axis)
                && axis.GetString() == "vertical"
                && parameters.TryGetProperty("restoreMode", out var restore)
                && restore.GetString() == "scene_snapshot";
        if (actionType != ShakeActionType
            || parameters.EnumerateObject().Count() != 8
            || label.GetString() != "지진이야!"
            || controlType.GetString() != "screen_shake"
            || durationMs is < 2_000 or > 10_000
            || !parameters.TryGetProperty("intensity", out var intensityValue)
            || intensityValue.ValueKind != JsonValueKind.String
            || !parameters.TryGetProperty("volumePercent", out var volume)
            || !volume.TryGetInt32(out volumePercent)
            || volumePercent is < 0 or > 100
            || !parameters.TryGetProperty("overlayImageKey", out var assetKey)
            || assetKey.GetString() != EarthquakeAssetKey)
            return false;
        intensity = intensityValue.GetString() ?? "";
        return intensity is "soft" or "standard" or "strong";
    }

    private static void RequireRequests(ObsServerInfo info)
    {
        var required = new[]
        {
            "GetSceneList", "GetCurrentProgramScene", "GetVideoSettings", "CreateScene",
            "RemoveScene", "CreateSceneItem", "SetSceneItemTransform", "SetCurrentProgramScene"
        };
        if (required.Any(name => !info.AvailableRequests.Contains(name)))
            throw new InvalidOperationException("현재 OBS WebSocket이 화면 액션에 필요한 기능을 지원하지 않습니다.");
    }

    private static async Task WaitBeforeDeadlineAsync(
        SemaphoreSlim gate,
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
        try { await gate.WaitAsync(deadline.Token); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new VNextActionExpiredException();
        }
    }

    private static string SafeMessage(Exception ex)
    {
        var message = (ex.Message ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length == 0 ? ex.GetType().Name : message[..Math.Min(message.Length, 180)];
    }
}
