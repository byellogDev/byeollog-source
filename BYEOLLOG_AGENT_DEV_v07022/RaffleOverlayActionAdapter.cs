using System.Security.Cryptography;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class RaffleOverlayActionAdapter
{
    internal const string ActionType = "raffle.overlay";
    internal const string TicketAudioBindingKey = "raffle-ticket-fixed-v1";
    internal const string WinnerPreviewAudioBindingKey = "raffle-winner-preview-v1";
    private readonly ByeollogOverlayService _overlay;
    private readonly Func<CancellationToken, Task<int>>? _refreshBrowserSources;
    private readonly Func<int, CancellationToken, Task<RafflePreparedAudio>>? _prepareTicketSpeech;
    private readonly Func<
        string,
        int,
        int,
        string,
        int,
        CancellationToken,
        Task<RafflePreparedAudio>>? _prepareWinnerSpeech;
    private readonly Func<CancellationToken, Task<bool>>? _ensureBrowserAudioRouting;
    private readonly Action<string>? _log;
    private readonly SemaphoreSlim _documentRefreshGate = new(1, 1);
    private readonly SemaphoreSlim _presentationGate = new(1, 1);
    private bool _currentDocumentObserved;

    public RaffleOverlayActionAdapter(
        ByeollogOverlayService overlay,
        Func<CancellationToken, Task<int>>? refreshBrowserSources = null,
        Func<int, CancellationToken, Task<RafflePreparedAudio>>? prepareTicketSpeech = null,
        Func<
            string,
            int,
            int,
            string,
            int,
            CancellationToken,
            Task<RafflePreparedAudio>>? prepareWinnerSpeech = null,
        Func<CancellationToken, Task<bool>>? ensureBrowserAudioRouting = null,
        Action<string>? log = null)
    {
        _overlay = overlay;
        _refreshBrowserSources = refreshBrowserSources;
        _prepareTicketSpeech = prepareTicketSpeech;
        _prepareWinnerSpeech = prepareWinnerSpeech;
        _ensureBrowserAudioRouting = ensureBrowserAudioRouting;
        _log = log;
    }

    public async Task<VNextAgentOutcome> ExecuteAsync(
        string executionId,
        int attemptNo,
        JsonElement parameters,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        if (!Guid.TryParseExact(executionId, "D", out _)
            || attemptNo is < 1 or > 10)
            return new VNextAgentOutcome(false, false, null, "추첨 실행 식별값이 올바르지 않습니다.");

        if (TryReadTestSequence(parameters, out var sequence, out var sequenceError))
        {
            try
            {
                await EnsureCurrentOverlayDocumentAsync(cancellationToken);
                var ticketEvidence = await ShowWithSpeechAsync(
                    sequence!.TicketAssetKey,
                    sequence.TicketDurationMs,
                    new RaffleOverlayPresentation(
                        "ticket_granted",
                        "추첨권 지급",
                        "테스트 시청자님, 추첨권을 1장 드렸어요!",
                        "추첨함에 총 1장/1명",
                        Array.Empty<string>()),
                    sequence.TicketPlacement,
                    TicketSpeechPreparation(sequence.TicketVolumePercent),
                    TicketAudioBindingKey,
                    sequence.TicketVolumePercent,
                    cancellationToken,
                    notAfterUtc);
                var drawEvidence = await ShowWithSpeechAsync(
                    sequence.DrawAssetKey,
                    sequence.DrawDurationMs,
                    new RaffleOverlayPresentation(
                        "draw_result",
                        "추첨 1/1",
                        "테스트 시청자님 당첨!",
                        "축하합니다!",
                        new[] { "테스트 시청자" }),
                    sequence.DrawPlacement,
                    WinnerSpeechPreparation(
                        executionId,
                        attemptNo,
                        0,
                        RaffleWinnerSpeechCache.ComputeVoiceKey("테스트 시청자"),
                        sequence.DrawVolumePercent),
                    RaffleWinnerSpeechCache.ComputeVoiceKey("테스트 시청자"),
                    sequence.DrawVolumePercent,
                    cancellationToken,
                    notAfterUtc);
                return new VNextAgentOutcome(true, false, new
                {
                    message = "RAFFLE_TEST_SEQUENCE_COMPLETED",
                    kind = "test_sequence",
                    overlayEvidence = new[] { ticketEvidence, drawEvidence },
                    speechAttempted = ticketEvidence.SpeechAttempted || drawEvidence.SpeechAttempted,
                    ttsPlayed = ticketEvidence.TtsPlayed && drawEvidence.TtsPlayed
                }, null);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (VNextActionExpiredException ex)
            {
                return new VNextAgentOutcome(false, false, null, ex.Message);
            }
            catch (Exception ex)
            {
                return new VNextAgentOutcome(false, true, null, "추첨 테스트 송출을 표시하지 못했습니다: " + SafeMessage(ex));
            }
        }
        if (parameters.ValueKind == JsonValueKind.Object
            && parameters.TryGetProperty("kind", out var requestedKind)
            && requestedKind.ValueKind == JsonValueKind.String
            && requestedKind.GetString() == "test_sequence")
            return new VNextAgentOutcome(false, false, null, sequenceError);
        if (!TryRead(parameters, out var assetKey, out var durationMs, out var presentation, out var error))
            return new VNextAgentOutcome(false, false, null, error);
        if (!TryOptionalPlacement(parameters, "overlay", out var placement))
            return new VNextAgentOutcome(false, false, null, "추첨 오버레이 위치 또는 크기가 올바르지 않습니다.");
        if (!TryOptionalVolume(parameters, "volumePercent", out var volumePercent))
            return new VNextAgentOutcome(false, false, null, "추첨 오버레이 음량이 올바르지 않습니다.");
        try
        {
            await EnsureCurrentOverlayDocumentAsync(cancellationToken);
            var overlayEvidence = new List<RafflePresentationExecutionEvidence>();
            if (presentation!.Kind == "draw_result")
            {
                var winnerVoiceKeys = ReadWinnerVoiceKeys(parameters, presentation.WinnerNames.Count);
                var firstDrawIndex = 1;
                var winnerTarget = presentation.WinnerNames.Count;
                if (parameters.TryGetProperty("drawIndex", out var drawIndexValue)
                    && parameters.TryGetProperty("winnerTarget", out var winnerTargetValue)
                    && drawIndexValue.TryGetInt32(out var parsedDrawIndex)
                    && winnerTargetValue.TryGetInt32(out var parsedWinnerTarget)
                    && parsedDrawIndex is >= 1 and <= 100
                    && parsedWinnerTarget is >= 1 and <= 100
                    && parsedDrawIndex <= parsedWinnerTarget)
                {
                    firstDrawIndex = parsedDrawIndex;
                    winnerTarget = parsedWinnerTarget;
                }
                for (var index = 0; index < presentation.WinnerNames.Count; index++)
                {
                    var actorName = presentation.WinnerNames[index];
                    var displayName = actorName.EndsWith("님", StringComparison.Ordinal) ? actorName : actorName + "님";
                    var drawPresentation = new RaffleOverlayPresentation(
                        presentation.Kind,
                        $"추첨 {firstDrawIndex + index}/{winnerTarget}",
                        $"{displayName} 당첨!",
                        "축하합니다!",
                        new[] { actorName });
                    overlayEvidence.Add(await ShowWithSpeechAsync(
                        assetKey,
                        durationMs,
                        drawPresentation,
                        placement,
                        WinnerSpeechPreparation(
                            executionId,
                            attemptNo,
                            index,
                            winnerVoiceKeys[index],
                            volumePercent),
                        winnerVoiceKeys[index],
                        volumePercent,
                        cancellationToken,
                        notAfterUtc));
                }
            }
            else
            {
                _ = TryInt(parameters, "ticketsGranted", 1, 100_000, out var granted);
                _ = TryText(parameters, "actorName", 1, 120, out var actorName);
                overlayEvidence.Add(await ShowWithSpeechAsync(
                    assetKey,
                    durationMs,
                    presentation,
                    placement,
                    TicketSpeechPreparation(volumePercent),
                    TicketAudioBindingKey,
                    volumePercent,
                    cancellationToken,
                    notAfterUtc));
            }
            return new VNextAgentOutcome(true, false, new
            {
                message = presentation.Kind == "ticket_granted" ? "RAFFLE_TICKET_OVERLAY_COMPLETED" : "RAFFLE_DRAW_OVERLAY_COMPLETED",
                kind = presentation.Kind,
                overlayEvidence,
                speechAttempted = overlayEvidence.Any(item => item.SpeechAttempted),
                ttsPlayed = overlayEvidence.Count > 0 && overlayEvidence.All(item => item.TtsPlayed)
            }, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (VNextActionExpiredException ex)
        {
            return new VNextAgentOutcome(false, false, null, ex.Message);
        }
        catch (Exception ex)
        {
            return new VNextAgentOutcome(false, true, null, "추첨 오버레이를 표시하지 못했습니다: " + SafeMessage(ex));
        }
    }

    private async Task<RafflePresentationExecutionEvidence> ShowWithSpeechAsync(
        string assetKey,
        int durationMs,
        RaffleOverlayPresentation presentation,
        TimedMuteOverlayPlacement placement,
        Func<CancellationToken, Task<RafflePreparedAudio>>? prepareSpeech,
        string? expectedBindingKey,
        int volumePercent,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        await _presentationGate.WaitAsync(cancellationToken);
        try
        {
            // Winner audio is generated before the visual is made active.  Once
            // OBS confirms the exact presentation, playback can begin without
            // a model/network gap between the picture and the announcement.
            var preparedSpeech = await PrepareSpeechBestEffortAsync(
                prepareSpeech,
                expectedBindingKey,
                volumePercent,
                cancellationToken,
                notAfterUtc);
            preparedSpeech = await EnsureBrowserAudioRoutingBestEffortAsync(
                preparedSpeech,
                cancellationToken,
                notAfterUtc);
            if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                throw new VNextActionExpiredException();
            var synchronized = await _overlay.ShowObservedAudioTransientAsync(
                assetKey,
                durationMs,
                presentation,
                placement,
                preparedSpeech.Audio,
                cancellationToken,
                notAfterUtc);
            var speech = new RaffleSpeechEvidence(
                preparedSpeech.Attempted,
                preparedSpeech.Audio is not null && synchronized.AudioEvidence.Ended,
                preparedSpeech.FailureType ?? synchronized.AudioEvidence.FailureType,
                preparedSpeech.Source,
                preparedSpeech.FallbackReason);
            _log?.Invoke(
                $"추첨 OBS 음성 결과 · attempted={speech.Attempted} · requested={synchronized.AudioEvidence.Requested} · started={synchronized.AudioEvidence.Started} · ended={synchronized.AudioEvidence.Ended} · source={speech.Source ?? "none"} · fallback={speech.FallbackReason ?? "none"} · failure={speech.FailureType ?? "none"}");
            return new RafflePresentationExecutionEvidence(
                synchronized.OverlayEvidence,
                synchronized.AudioEvidence,
                speech.Attempted,
                speech.Played,
                speech.FailureType,
                speech.Source,
                speech.FallbackReason);
        }
        finally
        {
            _presentationGate.Release();
        }
    }

    private async Task<PreparedRaffleSpeech> PrepareSpeechBestEffortAsync(
        Func<CancellationToken, Task<RafflePreparedAudio>>? prepareSpeech,
        string? expectedBindingKey,
        int volumePercent,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        if (prepareSpeech is null || volumePercent == 0)
            return new PreparedRaffleSpeech(false, null, null, null, null);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (notAfterUtc is not null)
        {
            var remaining = notAfterUtc.Value - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
                throw new VNextActionExpiredException();
            deadline.CancelAfter(remaining);
        }
        try
        {
            var prepared = await prepareSpeech(deadline.Token);
            if (prepared is null
                || expectedBindingKey is null
                || !string.Equals(
                    prepared.BindingKey,
                    expectedBindingKey,
                    StringComparison.Ordinal)
                || prepared.Audio.Length is < 44 or > ByeollogRaffleAudio.MaximumWinnerAudioBytes
                || prepared.ContentSha256.Length != 64
                || !prepared.ContentSha256.All(static character =>
                    character is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new InvalidDataException("준비된 추첨 음성의 대상 또는 형식이 올바르지 않습니다.");
            var actualHash = SHA256.HashData(prepared.Audio);
            if (!CryptographicOperations.FixedTimeEquals(
                    actualHash,
                    Convert.FromHexString(prepared.ContentSha256)))
                throw new InvalidDataException("준비된 추첨 음성의 무결성이 올바르지 않습니다.");
            ByeollogRaffleAudio.ValidateWinnerAudioForPreflight(prepared.Audio);
            return new PreparedRaffleSpeech(
                true,
                new RaffleOverlayAudioContent(
                    prepared.Audio.ToArray(),
                    prepared.ContentSha256,
                    volumePercent,
                    prepared.BindingKey),
                null,
                prepared.Source,
                prepared.FallbackReason);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (
            notAfterUtc is not null
            && DateTimeOffset.UtcNow >= notAfterUtc.Value)
        {
            throw new VNextActionExpiredException();
        }
        catch (Exception ex)
        {
            _log?.Invoke("추첨 TTS 준비 보류 · type=" + ex.GetType().Name);
            return new PreparedRaffleSpeech(true, null, ex.GetType().Name, null, null);
        }
    }

    private async Task<PreparedRaffleSpeech> EnsureBrowserAudioRoutingBestEffortAsync(
        PreparedRaffleSpeech preparedSpeech,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        if (preparedSpeech.Audio is null || _ensureBrowserAudioRouting is null)
            return preparedSpeech;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (notAfterUtc is not null)
        {
            var remaining = notAfterUtc.Value - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
                throw new VNextActionExpiredException();
            deadline.CancelAfter(remaining);
        }
        try
        {
            if (await _ensureBrowserAudioRouting(deadline.Token))
                return preparedSpeech;
            _log?.Invoke("추첨 OBS 음성 라우팅 보류 · type=ObsAudioRoutingUnavailable");
            return preparedSpeech with
            {
                Audio = null,
                FailureType = "ObsAudioRoutingUnavailable"
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (
            notAfterUtc is not null
            && DateTimeOffset.UtcNow >= notAfterUtc.Value)
        {
            throw new VNextActionExpiredException();
        }
        catch (Exception ex)
        {
            _log?.Invoke("추첨 OBS 음성 라우팅 보류 · type=" + ex.GetType().Name);
            return preparedSpeech with
            {
                Audio = null,
                FailureType = ex.GetType().Name
            };
        }
    }

    internal const string TicketSpeechText = "추첨권을 드렸어요!";

    private Func<CancellationToken, Task<RafflePreparedAudio>>? TicketSpeechPreparation(
        int volumePercent) =>
        _prepareTicketSpeech is null
            ? null
            : token => _prepareTicketSpeech(volumePercent, token);

    private Func<CancellationToken, Task<RafflePreparedAudio>>? WinnerSpeechPreparation(
        string executionId,
        int attemptNo,
        int winnerOrdinal,
        string? expectedVoiceKey,
        int volumePercent) =>
        _prepareWinnerSpeech is null || expectedVoiceKey is null
            ? null
            : token => _prepareWinnerSpeech(
                executionId,
                attemptNo,
                winnerOrdinal,
                expectedVoiceKey,
                volumePercent,
                token);

    private IReadOnlyList<string?> ReadWinnerVoiceKeys(JsonElement parameters, int expectedCount)
    {
        var keys = Enumerable.Repeat<string?>(null, expectedCount).ToArray();
        if (!parameters.TryGetProperty("winners", out var winners)
            || winners.ValueKind != JsonValueKind.Array
            || winners.GetArrayLength() != expectedCount)
            return keys;

        var index = 0;
        foreach (var winner in winners.EnumerateArray())
        {
            if (winner.ValueKind == JsonValueKind.Object
                && TryText(winner, "actorName", 1, 120, out var actorName)
                && winner.TryGetProperty("voiceKey", out var voiceKey)
                && voiceKey.ValueKind == JsonValueKind.String)
            {
                var value = voiceKey.GetString()?.Trim().ToLowerInvariant() ?? "";
                if (value.Length == 64 && value.All(static character =>
                        character is >= '0' and <= '9' or >= 'a' and <= 'f')
                    && string.Equals(
                        value,
                        RaffleWinnerSpeechCache.ComputeVoiceKey(actorName),
                        StringComparison.Ordinal))
                    keys[index] = value;
            }
            if (keys[index] is null)
                _log?.Invoke($"당첨 TTS 대상 키 없음 · ordinal={index} · visual-only");
            index++;
        }
        return keys;
    }

    internal async Task EnsureCurrentOverlayDocumentAsync(CancellationToken cancellationToken)
    {
        await _documentRefreshGate.WaitAsync(cancellationToken);
        try
        {
            if (await _overlay.WaitForCurrentDocumentBrowserSourceAsync(
                    TimeSpan.FromMilliseconds(600),
                    cancellationToken))
            {
                _currentDocumentObserved = true;
                return;
            }

            var refreshed = 0;
            try
            {
                if (_refreshBrowserSources is null)
                    throw new OverlayPresentationNotObservedException();
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(6));
                refreshed = await _refreshBrowserSources(timeout.Token);
                _currentDocumentObserved = await _overlay.WaitForCurrentDocumentBrowserSourceAsync(
                    TimeSpan.FromSeconds(3),
                    timeout.Token,
                    requireNewRequest: true);
                _log?.Invoke(
                    $"추첨 오버레이 문서 갱신 · revision={ByeollogOverlayService.DocumentRevision} · refreshed={refreshed} · ready={_currentDocumentObserved}");
                if (!_currentDocumentObserved)
                    throw new OverlayPresentationNotObservedException();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _log?.Invoke(
                    $"추첨 오버레이 문서 갱신 보류 · revision={ByeollogOverlayService.DocumentRevision} · refreshed={refreshed} · type={ex.GetType().Name}");
                throw;
            }
        }
        finally
        {
            _documentRefreshGate.Release();
        }
    }

    internal static bool TryRead(
        JsonElement parameters,
        out string assetKey,
        out int durationMs,
        out RaffleOverlayPresentation? presentation,
        out string error)
    {
        assetKey = ""; durationMs = 0; presentation = null; error = "잘못된 추첨 오버레이 액션입니다.";
        if (parameters.ValueKind != JsonValueKind.Object
            || !TryText(parameters, "kind", 1, 32, out var kind)
            || !TryText(parameters, "overlayImageKey", 2, 64, out assetKey)
            || !parameters.TryGetProperty("durationMs", out var durationValue)
            || !durationValue.TryGetInt32(out durationMs)
            || durationMs is < 1_000 or > 15_000
            || !TryOptionalPlacement(parameters, "overlay", out _)
            || !TryOptionalVolume(parameters, "volumePercent", out _))
            return false;

        if (kind == "ticket_granted")
        {
            if (assetKey != OverlayAssetCache.RaffleTicketGrantedAssetKey
                || !TryText(parameters, "actorName", 1, 120, out var actorName)
                || !TryInt(parameters, "ticketsGranted", 1, 100_000, out var granted)
                || !TryInt(parameters, "actorTickets", 1, 100_000, out var actorTickets)
                || !TryInt(parameters, "totalTickets", 1, 1_000_000, out var totalTickets)
                || !TryInt(parameters, "participantCount", 1, 100_000, out var participants))
                return false;
            var displayName = actorName.EndsWith("님", StringComparison.Ordinal) ? actorName : actorName + "님";
            presentation = new RaffleOverlayPresentation(
                kind,
                "추첨권 지급",
                $"{displayName}, 추첨권을 {granted}장 드렸어요!",
                $"추첨함에 총 {totalTickets}장/{participants}명",
                Array.Empty<string>());
            error = "";
            return true;
        }

        if (kind == "draw_result")
        {
            if (assetKey != OverlayAssetCache.RaffleDrawAssetKey
                || !TryInt(parameters, "winnerCount", 1, 100, out var winnerCount)
                || !parameters.TryGetProperty("winners", out var winnersValue)
                || winnersValue.ValueKind != JsonValueKind.Array
                || winnersValue.GetArrayLength() != winnerCount)
                return false;
            var hasDrawIndex = parameters.TryGetProperty("drawIndex", out var drawIndexValue);
            var hasWinnerTarget = parameters.TryGetProperty("winnerTarget", out var winnerTargetValue);
            var firstExpectedIndex = 1;
            if (hasDrawIndex || hasWinnerTarget)
            {
                if (!hasDrawIndex || !hasWinnerTarget || winnerCount != 1
                    || !drawIndexValue.TryGetInt32(out firstExpectedIndex)
                    || !winnerTargetValue.TryGetInt32(out var winnerTarget)
                    || firstExpectedIndex is < 1 or > 100
                    || winnerTarget is < 1 or > 100
                    || firstExpectedIndex > winnerTarget)
                    return false;
            }
            var winners = new List<string>(winnerCount);
            var expectedIndex = firstExpectedIndex;
            foreach (var winner in winnersValue.EnumerateArray())
            {
                if (winner.ValueKind != JsonValueKind.Object
                    || !TryInt(winner, "drawIndex", expectedIndex, expectedIndex, out _)
                    || !TryText(winner, "actorName", 1, 120, out var name))
                    return false;
                winners.Add(name);
                expectedIndex++;
            }
            presentation = new RaffleOverlayPresentation(
                kind,
                "추첨 결과",
                winnerCount == 1 ? "당첨자를 발표합니다" : $"{winnerCount}개의 당첨 결과",
                "축하합니다!",
                winners);
            error = "";
            return true;
        }
        return false;
    }

    internal static bool TryReadTestSequence(
        JsonElement parameters,
        out RaffleOverlayTestSequence? sequence,
        out string error)
    {
        sequence = null;
        error = "잘못된 추첨 테스트 송출 액션입니다.";
        if (parameters.ValueKind != JsonValueKind.Object
            || !TryText(parameters, "kind", 1, 32, out var kind)
            || kind != "test_sequence"
            || !TryText(parameters, "ticketOverlayImageKey", 2, 64, out var ticketAssetKey)
            || ticketAssetKey != OverlayAssetCache.RaffleTicketGrantedAssetKey
            || !TryInt(parameters, "ticketDurationMs", 1_000, 15_000, out var ticketDurationMs)
            || !TryOptionalPlacement(parameters, "ticketOverlay", out var ticketPlacement)
            || !TryOptionalVolume(parameters, "ticketVolumePercent", out var ticketVolumePercent)
            || !TryText(parameters, "drawOverlayImageKey", 2, 64, out var drawAssetKey)
            || drawAssetKey != OverlayAssetCache.RaffleDrawAssetKey
            || !TryInt(parameters, "drawDurationMs", 1_000, 15_000, out var drawDurationMs)
            || !TryOptionalPlacement(parameters, "drawOverlay", out var drawPlacement)
            || !TryOptionalVolume(parameters, "drawVolumePercent", out var drawVolumePercent))
            return false;
        sequence = new RaffleOverlayTestSequence(
            ticketAssetKey,
            ticketDurationMs,
            ticketPlacement,
            ticketVolumePercent,
            drawAssetKey,
            drawDurationMs,
            drawPlacement,
            drawVolumePercent);
        error = "";
        return true;
    }

    internal static int EffectiveTimeoutMs(JsonElement parameters, int jobTimeoutMs)
    {
        long required;
        if (TryRead(
                parameters,
                out _,
                out var durationMs,
                out var presentation,
                out _)
            && presentation is not null)
        {
            var displays = presentation.Kind == "draw_result"
                ? presentation.WinnerNames.Count
                : 1;
            required = checked(
                (long)TimedMuteContract.MaximumAccumulatedDurationMs
                + (long)durationMs * displays
                + 30_000L);
        }
        else if (TryReadTestSequence(parameters, out var sequence, out _)
            && sequence is not null)
        {
            required = checked(
                (long)TimedMuteContract.MaximumAccumulatedDurationMs
                + sequence.TicketDurationMs
                + sequence.DrawDurationMs
                + 30_000L);
        }
        else
        {
            return jobTimeoutMs;
        }
        return (int)Math.Min(Math.Max(jobTimeoutMs, required), 3_600_000L);
    }

    private static bool TryOptionalVolume(JsonElement parameters, string property, out int volumePercent)
    {
        if (!parameters.TryGetProperty(property, out var value))
        {
            volumePercent = 80;
            return true;
        }
        return value.TryGetInt32(out volumePercent) && volumePercent is >= 0 and <= 100;
    }

    private static bool TryOptionalPlacement(
        JsonElement parameters,
        string prefix,
        out TimedMuteOverlayPlacement placement)
    {
        var xName = prefix + "PositionX";
        var yName = prefix + "PositionY";
        var scaleName = prefix + "ScalePercent";
        var hasX = parameters.TryGetProperty(xName, out var xValue);
        var hasY = parameters.TryGetProperty(yName, out var yValue);
        var hasScale = parameters.TryGetProperty(scaleName, out var scaleValue);
        if (!hasX && !hasY && !hasScale)
        {
            placement = new TimedMuteOverlayPlacement(5000, 5000, 100);
            return true;
        }
        if (!hasX || !hasY || !hasScale
            || !xValue.TryGetInt32(out var x) || x is < 0 or > 10_000
            || !yValue.TryGetInt32(out var y) || y is < 0 or > 10_000
            || !scaleValue.TryGetInt32(out var scale) || scale is < 25 or > 200)
        {
            placement = new TimedMuteOverlayPlacement(5000, 5000, 100);
            return false;
        }
        placement = new TimedMuteOverlayPlacement(x, y, scale);
        return true;
    }

    private static bool TryText(JsonElement value, string property, int minimum, int maximum, out string text)
    {
        text = "";
        if (!value.TryGetProperty(property, out var propertyValue) || propertyValue.ValueKind != JsonValueKind.String)
            return false;
        text = propertyValue.GetString()?.Trim() ?? "";
        return text.Length >= minimum && text.Length <= maximum && !text.Any(char.IsControl);
    }

    private static bool TryInt(JsonElement value, string property, int minimum, int maximum, out int number)
    {
        number = 0;
        return value.TryGetProperty(property, out var propertyValue)
            && propertyValue.TryGetInt32(out number)
            && number >= minimum && number <= maximum;
    }

    private static string SafeMessage(Exception ex)
    {
        var message = (ex.Message ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length == 0 ? ex.GetType().Name : message[..Math.Min(message.Length, 180)];
    }
}

internal sealed record RaffleOverlayTestSequence(
    string TicketAssetKey,
    int TicketDurationMs,
    TimedMuteOverlayPlacement TicketPlacement,
    int TicketVolumePercent,
    string DrawAssetKey,
    int DrawDurationMs,
    TimedMuteOverlayPlacement DrawPlacement,
    int DrawVolumePercent);

internal sealed record RaffleSpeechEvidence(
    bool Attempted,
    bool Played,
    string? FailureType,
    string? Source,
    string? FallbackReason);

internal sealed record PreparedRaffleSpeech(
    bool Attempted,
    RaffleOverlayAudioContent? Audio,
    string? FailureType,
    string? Source,
    string? FallbackReason);

internal sealed record RafflePreparedAudio(
    byte[] Audio,
    string ContentSha256,
    string BindingKey,
    string Source = "embedded_fixed",
    string? FallbackReason = null);

internal sealed record RafflePresentationExecutionEvidence(
    ByeollogOverlayDisplayEvidence Overlay,
    ByeollogOverlayAudioEvidence Audio,
    bool SpeechAttempted,
    bool TtsPlayed,
    string? TtsFailureType,
    string? TtsSource,
    string? TtsFallbackReason);
