using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NAudio.Wave;

namespace HurogiCollector;

internal static class Program
{
    private static int _assertions;
    private static readonly string[] ProtocolV1FixtureRootFiles =
    [
        "LAUNCH_BYEOLLOG.cmd",
        "Byeollog-Launcher.ps1",
        "Install-Byeollog.ps1",
        "ROLLBACK_LAST_VERSION.cmd",
        "VERIFY_INSTALL.cmd",
        "RESTORE_PREUPDATE_STATE.cmd",
        "CREATE_SUPPORT_BUNDLE.cmd",
        "RUN_REPLAY_CANDIDATE_CHECK.cmd",
        "Collect-SupportBundle.ps1"
    ];

    private static async Task Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "byeollog-agent-store-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var databasePath = Path.Combine(root, "agent.sqlite");

        try
        {
            ReplayAcceptanceTests();
            AgentCapabilityTests();
            VoiceAnonymizerContractTests();
            ActionSoundAssetTests();
            WeflabRecoveryDecisionTests();
            SessionVaultTests(root);
            ActionFreshnessTests();
            True(VNextAgentStore.IsFinalLocalOutcome(
                    new VNextAgentAck("final-success", 1, true, false, null, null)),
                "successful local ACK is a final UI outcome");
            True(VNextAgentStore.IsFinalLocalOutcome(
                    new VNextAgentAck("final-failure", 1, false, false, null, "terminal")),
                "non-retryable local failure is a final UI outcome");
            False(VNextAgentStore.IsFinalLocalOutcome(
                    new VNextAgentAck("retryable-failure", 1, false, true, null, "temporary")),
                "retryable local failure keeps UI waiting for the server-scheduled attempt");
            RouletteResultParserTests();
            AgentUpdateTests(root);
            await AgentUpdateRedirectTestsAsync(root);
            string deviceId;
            using (var store = new VNextAgentStore(databasePath))
            {
                deviceId = store.GetOrCreateDeviceId();
                Equal(deviceId, store.GetOrCreateDeviceId(), "device ID is stable in-process");
                var initialHealth = store.Health();
                True(initialHealth.IntegrityOk, "SQLite quick_check is healthy");
                True(initialHealth.ForeignKeysOk, "SQLite foreign key check is healthy");
                Equal(3, initialHealth.SchemaVersion, "SQLite diagnostic reports current schema version");

                var successJob = Job("execution-success", 1, "local.log", "{\"label\":\"ONCE\"}");
                Equal("received", store.Receive(successJob).State, "new job is received");
                Equal("received", store.Receive(successJob).State, "same claim is deduplicated before execution");
                True(store.MarkExecuting(successJob.ExecutionId, 1), "received job starts once");
                False(store.MarkExecuting(successJob.ExecutionId, 1), "executing job cannot start twice");
                store.CompleteAndQueueAck(successJob.ExecutionId, 1, new VNextAgentOutcome(true, false, new { message = "ONCE" }, null));
                Equal("succeeded", store.GetReceipt(successJob.ExecutionId)?.State, "success receipt is durable");
                Equal(1, store.DueOutbox().Count, "success and ACK are committed together");
                True(store.GetRecordedAck(successJob.ExecutionId)?.Succeeded == true,
                    "local UI can observe a durable outcome before network ACK delivery");
                Equal<VNextAgentAck?>(null, store.GetSentAck(successJob.ExecutionId),
                    "a locally recorded ACK is not mislabeled as delivered to the server");

                Equal("succeeded", store.Receive(successJob).State, "redelivered success is not rerun");
                store.QueueCachedAck(successJob.ExecutionId, 1);
                Equal(1, store.DueOutbox().Count, "cached ACK does not duplicate outbox row");
                var successAck = store.DueOutbox().Single();
                store.MarkOutboxSent(successAck.Id);
                True(store.IsAckSent(successJob.ExecutionId), "sent ACK is recorded");

                var interrupted = Job("execution-interrupted", 1, "local.dev_delay", "{\"delayMs\":1000}");
                store.Receive(interrupted);
                True(store.MarkExecuting(interrupted.ExecutionId, 1), "interrupted fixture starts");

                var retryJob1 = Job("execution-retry", 1, "local.log", "{\"label\":\"RETRY\"}");
                store.Receive(retryJob1);
                True(store.MarkExecuting(retryJob1.ExecutionId, 1), "retry fixture starts attempt 1");
                store.CompleteAndQueueAck(retryJob1.ExecutionId, 1, new VNextAgentOutcome(false, true, null, "temporary"));
                Equal("retryable_failed", store.GetReceipt(retryJob1.ExecutionId)?.State, "retryable failure is preserved");

                var immutable = Job("execution-immutable", 1, "local.log", "{\"label\":\"A\"}");
                store.Receive(immutable);
                Throws<InvalidOperationException>(
                    () => store.Receive(Job("execution-immutable", 1, "local.log", "{\"label\":\"B\"}")),
                    "action snapshot cannot mutate between deliveries");

                var deviceBound = Job("execution-device-bound", 1, "local.log", "{\"label\":\"DEVICE\"}");
                Equal("received", store.Receive(deviceBound).State, "device-bound job is received");
                Equal("received", store.Receive(deviceBound).State, "same device may redeliver the job");
                Throws<InvalidOperationException>(
                    () => store.Receive(Job(
                        "execution-device-bound",
                        1,
                        "local.log",
                        "{\"label\":\"DEVICE\"}",
                        "22222222-2222-2222-2222-222222222222")),
                    "bound device cannot mutate between deliveries");

                var overlayDescriptor = ManagedDescriptor(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "managed_notice",
                    1,
                    Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"180\"><rect width=\"320\" height=\"180\"/></svg>"));
                var overlayJob = Job(
                    "execution-overlay-immutable",
                    1,
                    "obs.mute_for",
                    "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"managed_notice\"}",
                    overlayAsset: overlayDescriptor);
                Equal("received", store.Receive(overlayJob).State, "exact overlay revision is stored with the job");
                Equal("received", store.Receive(overlayJob).State, "same exact overlay revision may be redelivered");
                Throws<InvalidOperationException>(
                    () => store.Receive(overlayJob with
                    {
                        OverlayAsset = overlayDescriptor with
                        {
                            ContentSha256 = new string('f', 64)
                        }
                    }),
                    "overlay revision identity cannot mutate between deliveries");
                True(store.MarkExecuting(overlayJob.ExecutionId, 1), "acceptance fixture starts once");
                using var acceptanceResult = JsonDocument.Parse(
                    "{\"target\":\"microphone\",\"durationMs\":10000,\"initialMuted\":false,\"changed\":true,\"mutedVerified\":true,\"restoredVerified\":true,\"overlayAssetKey\":\"managed_notice\",\"overlayAssetId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"overlayAssetVersion\":1,\"overlayContentSha256\":\"" + overlayDescriptor.ContentSha256 + "\",\"overlayDisplayed\":true}");
                store.CompleteAndQueueAck(
                    overlayJob.ExecutionId,
                    1,
                    new VNextAgentOutcome(true, false, acceptanceResult.RootElement.Clone(), null));
                var overlayAck = store.DueOutbox().Single(item => item.Ack.ExecutionId == overlayJob.ExecutionId);
                store.MarkOutboxSent(overlayAck.Id);
                var acceptanceEvidence = store.FindFirstObsTimedMuteSince(DateTimeOffset.UtcNow.AddMinutes(-1));
                Equal("succeeded", acceptanceEvidence?.State, "acceptance evidence reads the first completed OBS timed mute");
                True(acceptanceEvidence?.AckSent == true, "acceptance evidence requires a sent ACK");
                Equal(overlayDescriptor.VersionNumber, acceptanceEvidence?.ExpectedOverlayAssetVersion,
                    "acceptance evidence preserves the expected overlay revision");
            }

            using (var store = new VNextAgentStore(databasePath))
            {
                Equal(deviceId, store.GetOrCreateDeviceId(), "device ID survives restart");
                Equal("succeeded", store.GetReceipt("execution-success")?.State, "success survives restart");
                Equal("uncertain", store.GetReceipt("execution-interrupted")?.State, "in-flight action becomes uncertain after restart");
                Equal(1, store.Stats().Uncertain, "uncertain work is visible in status");
                Equal(
                    "received",
                    store.Receive(Job("execution-device-bound", 1, "local.log", "{\"label\":\"DEVICE\"}")).State,
                    "device binding survives restart");

                var interrupted = Job("execution-interrupted", 1, "local.dev_delay", "{\"delayMs\":1000}");
                Equal("uncertain", store.Receive(interrupted).State, "uncertain redelivery remains blocked");
                store.ResolveUncertainAndQueueAck(interrupted.ExecutionId, 1);
                Equal("terminal_failed", store.GetReceipt(interrupted.ExecutionId)?.State, "uncertain action resolves without replay");

                var retryJob2 = Job("execution-retry", 2, "local.log", "{\"label\":\"RETRY\"}");
                Equal("received", store.Receive(retryJob2).State, "newer attempt unlocks retryable failure");
                True(store.MarkExecuting(retryJob2.ExecutionId, 2), "retry fixture starts attempt 2");
                store.CompleteAndQueueAck(retryJob2.ExecutionId, 2, new VNextAgentOutcome(true, false, null, null));
                Equal("succeeded", store.GetReceipt(retryJob2.ExecutionId)?.State, "newer retry attempt can succeed");

                var newer = Job("execution-newer", 2, "local.log", "{\"label\":\"NEW\"}");
                store.Receive(newer);
                Throws<InvalidOperationException>(
                    () => store.Receive(Job("execution-newer", 1, "local.log", "{\"label\":\"NEW\"}")),
                    "older attempt arriving late is rejected");
            }

            await TimedMuteTestsAsync();
            AcceptanceEvaluatorTests();
            await OverlayAssetCacheTestsAsync(root);
            RaffleActionTests(root);
            FlashbangActionTests(root);
            await RaffleSpeechCacheTestsAsync(root);
            await RaffleRuntimeSafetyTestsAsync(root);
            await OverlayDisplayPriorityTestsAsync(root);
            VNextSourceIdentityTests();
            AutomationRpcSerializationTests();
            WebViewTrustPolicyTests();
            CollectorStateLifecycleTests(root);
            Console.WriteLine($"PASS: {_assertions} Local Agent, timed mute, and vNext identity assertions");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static void WeflabRecoveryDecisionTests()
    {
        var gate = new WeflabRecoveryDecisionGate();
        False(gate.Observe(WeflabHealthSignal.ApiFailure),
            "a single Weflab API failure does not start recovery");
        Equal(1, gate.ConsecutiveFailures, "the first Weflab API failure is retained");
        False(gate.Observe(WeflabHealthSignal.LoginCandidate),
            "a login-page candidate is not treated as API recovery");
        Equal(1, gate.ConsecutiveFailures,
            "a login-page candidate cannot mask an outstanding API failure");
        True(gate.Observe(WeflabHealthSignal.ApiFailure),
            "two actual Weflab API failures start recovery");
        Equal(0, gate.ConsecutiveFailures, "a started recovery consumes the failure pair");
        False(gate.Observe(WeflabHealthSignal.ApiFailure), "a new failure series starts cleanly");
        False(gate.Observe(WeflabHealthSignal.ApiSuccess), "API success itself never starts recovery");
        Equal(0, gate.ConsecutiveFailures, "only actual API success clears failure history");
    }

    private static void SessionVaultTests(string root)
    {
        var vaultRoot = Path.Combine(root, "session-vault");
        var vault = new VNextSessionVault(vaultRoot);
        var refreshToken = "refresh-token-that-must-never-appear-in-plaintext-0123456789";
        var workspaceId = Guid.NewGuid().ToString("D");
        var userId = Guid.NewGuid();
        var remembered = new VNextRememberedSession(
            refreshToken,
            workspaceId,
            userId,
            "streamer@example.com",
            DateTimeOffset.UtcNow);

        vault.Save(remembered);
        var vaultPath = Path.Combine(vaultRoot, "vnext-session", "refresh-token.v1.dpapi");
        True(File.Exists(vaultPath), "DPAPI refresh-token vault is written");
        False(
            Encoding.UTF8.GetString(File.ReadAllBytes(vaultPath)).Contains(refreshToken, StringComparison.Ordinal),
            "refresh token is never stored as plaintext");
        True(vault.TryRead(out var restored), "current Windows user can restore the DPAPI vault");
        Equal(refreshToken, restored.RefreshToken, "restored refresh token matches");
        Equal(workspaceId, restored.WorkspaceId, "restored workspace remains pinned");
        Equal(userId, restored.UserId, "restored principal remains pinned");

        vault.MarkDisconnectedAndDelete();
        False(vault.TryRead(out _), "explicit disconnect tombstone suppresses restore");
        False(File.Exists(vaultPath), "explicit disconnect removes the refresh-token vault");

        vault.Save(remembered with { SavedAt = DateTimeOffset.UtcNow });
        True(vault.TryRead(out _), "a later verified login clears the disconnect tombstone");
        File.WriteAllBytes(vaultPath, [1, 2, 3, 4]);
        False(vault.TryRead(out _), "corrupt DPAPI bytes fail closed");
        False(File.Exists(vaultPath), "corrupt refresh-token vault is removed");
    }

    private static void ActionSoundAssetTests()
    {
        var earthquake = ActionSoundFactory.CreateEarthquake(2_000);
        Equal(384_044, earthquake.Length, "two-second earthquake natural sound has exact stereo PCM length");
        Equal("RIFF", Encoding.ASCII.GetString(earthquake, 0, 4), "earthquake natural sound keeps RIFF");
        Equal("WAVE", Encoding.ASCII.GetString(earthquake, 8, 4), "earthquake natural sound keeps WAVE");
        Equal(384_000, BitConverter.ToInt32(earthquake, 40), "earthquake trimmed data length is exact");
        var sustainedEarthquake = ActionSoundFactory.CreateEarthquake(10_600);
        Equal(2_035_244, sustainedEarthquake.Length,
            "earthquake action audio fills ten seconds plus its natural decay tail");
        Equal(2_035_200, BitConverter.ToInt32(sustainedEarthquake, 40),
            "earthquake decay tail keeps an exact PCM data length");
        Equal(
            "5622afc8e00c43413d1c14684ea37cea6b0e7577b9e953273920ef14a389f298",
            Convert.ToHexString(SHA256.HashData(ActionSoundFactory.CreateWaterSplash())).ToLowerInvariant(),
            "water action uses the reviewed CC0 natural recording");
        Equal(
            "16f5f25be2dd82f1264cb6094256dc17bf97be10c8b20f3b7765cad00559a2c8",
            Convert.ToHexString(SHA256.HashData(ActionSoundFactory.CreateFireworks())).ToLowerInvariant(),
            "celebration action uses the reviewed CC0 party popper recording");
        Throws<ArgumentOutOfRangeException>(
            () => ActionSoundFactory.CreateEarthquake(1_000),
            "earthquake natural sound rejects an out-of-contract duration");
    }

    private static void VoiceAnonymizerContractTests()
    {
        const string exact = """{"label":"(신원보호모드/개발중)","controlType":"voice_anonymize","target":"microphone","durationMs":10000,"preset":"anonymous_low","requiresObsMicInput":true,"requiresObsFilter":true}""";
        using var accepted = JsonDocument.Parse(exact);
        True(
            ObsVoiceAnonymizerContract.TryReadParameters(accepted.RootElement, out var durationMs),
            "voice anonymizer accepts only the pinned server-to-Agent payload");
        Equal(10_000, durationMs, "voice anonymizer preserves the bounded duration");
        True(
            ObsVoiceAnonymizerContract.TryReadParameters(
                accepted.RootElement,
                out _,
                out var lowPreset),
            "voice anonymizer returns the selected preset to the local adapter");
        Equal(ObsVoiceAnonymizerContract.DownPreset, lowPreset,
            "legacy low preset remains accepted exactly");
        using var acceptedHigh = JsonDocument.Parse(exact.Replace(
            "anonymous_low",
            "anonymous_high",
            StringComparison.Ordinal));
        True(
            ObsVoiceAnonymizerContract.TryReadParameters(
                acceptedHigh.RootElement,
                out var highDurationMs,
                out var highPreset),
            "voice anonymizer accepts the packaged high preset");
        Equal(10_000, highDurationMs, "high voice preset preserves the bounded duration");
        Equal(ObsVoiceAnonymizerContract.UpPreset, highPreset,
            "high voice preset is returned exactly");

        using var forgedLabel = JsonDocument.Parse(exact.Replace(
            "(신원보호모드/개발중)",
            "신원보호모드",
            StringComparison.Ordinal));
        False(
            ObsVoiceAnonymizerContract.TryReadParameters(forgedLabel.RootElement, out _),
            "voice anonymizer rejects a relabeled remote action");
        using var forgedPreset = JsonDocument.Parse(exact.Replace(
            "anonymous_low",
            "remote_plugin",
            StringComparison.Ordinal));
        False(
            ObsVoiceAnonymizerContract.TryReadParameters(forgedPreset.RootElement, out _),
            "voice anonymizer rejects an unapproved remote preset");
        using var extraRemoteFilter = JsonDocument.Parse(
            exact[..^1] + ",\"obsFilterName\":\"remote target\"}");
        False(
            ObsVoiceAnonymizerContract.TryReadParameters(extraRemoteFilter.RootElement, out _),
            "voice anonymizer rejects remote OBS filter selection");
        using var tooShort = JsonDocument.Parse(exact.Replace(
            "\"durationMs\":10000",
            "\"durationMs\":2999",
            StringComparison.Ordinal));
        False(
            ObsVoiceAnonymizerContract.TryReadParameters(tooShort.RootElement, out _),
            "voice anonymizer enforces the three-second minimum");
        using var tooLong = JsonDocument.Parse(exact.Replace(
            "\"durationMs\":10000",
            "\"durationMs\":60001",
            StringComparison.Ordinal));
        False(
            ObsVoiceAnonymizerContract.TryReadParameters(tooLong.RootElement, out _),
            "voice anonymizer enforces the sixty-second maximum");

        var targetKey = ObsVoiceAnonymizerContract.EncodeTargetKey(
            "마이크/Aux",
            "별록 신원보호모드");
        True(
            ObsVoiceAnonymizerContract.TryDecodeTargetKey(
                targetKey,
                out var sourceName,
                out var filterName),
            "voice anonymizer recovery target round-trips through the local journal key");
        Equal("마이크/Aux", sourceName, "voice recovery preserves the exact local source name");
        Equal("별록 신원보호모드", filterName, "voice recovery preserves the exact local filter name");
        False(
            ObsVoiceAnonymizerContract.TryDecodeTargetKey("마이크\u001f필터\u001f위조", out _, out _),
            "voice recovery rejects an ambiguous target key");
        True(
            VNextAgentCapabilities.ForWindowsAgent().Contains(
                "obs.voice_anonymize_for",
                StringComparer.Ordinal),
            "Windows Agent advertises the legacy voice anonymizer capability");
        True(
            VNextAgentCapabilities.ForWindowsAgent().Contains(
                "obs.voice_anonymize_for_v2",
                StringComparer.Ordinal),
            "Windows Agent advertises the version-isolated pitch preset capability");
    }

    private static void RaffleActionTests(string root)
    {
        var cache = new OverlayAssetCache(Path.Combine(root, "raffle-overlay"));
        True(cache.TryResolve(OverlayAssetCache.RaffleTicketGrantedAssetKey, null, out var ticket),
            "embedded raffle ticket GIF resolves without network access");
        Equal("image/gif", ticket.MimeType, "raffle ticket uses an animated GIF descriptor");
        Equal(OverlayAssetCache.RaffleTicketGrantedContentSha256, ticket.ContentSha256,
            "raffle ticket GIF matches its immutable SHA-256");
        True(cache.Read(ticket).Bytes.AsSpan(0, 6).SequenceEqual("GIF89a"u8),
            "raffle ticket asset has a GIF89a header");
        True(cache.TryResolve(OverlayAssetCache.RaffleDrawAssetKey, null, out var draw),
            "embedded raffle draw GIF resolves without network access");
        Equal(OverlayAssetCache.RaffleDrawContentSha256, draw.ContentSha256,
            "raffle draw GIF matches its immutable SHA-256");
        True(cache.Read(draw).Bytes.AsSpan(0, 6).SequenceEqual("GIF89a"u8),
            "raffle draw asset has a GIF89a header");
        True(VNextAgentCapabilities.ForWindowsAgent().Contains(RaffleOverlayActionAdapter.ActionType),
            "agent advertises the raffle overlay capability");

        using var ticketJson = JsonDocument.Parse("""{"kind":"ticket_granted","overlayImageKey":"raffle_ticket_granted","durationMs":5000,"actorName":"별님","ticketsGranted":3,"actorTickets":7,"totalTickets":21,"participantCount":5}""");
        True(RaffleOverlayActionAdapter.TryRead(ticketJson.RootElement, out var ticketKey, out var ticketDuration, out var ticketPresentation, out _),
            "strict raffle ticket payload is accepted");
        Equal(OverlayAssetCache.RaffleTicketGrantedAssetKey, ticketKey, "raffle ticket payload selects only the ticket GIF");
        Equal(5000, ticketDuration, "raffle ticket duration is bounded and preserved");
        Equal("별님, 추첨권 3장!", ticketPresentation?.Primary,
            "raffle ticket overlay uses the compact viewer and granted-count copy");
        Equal("", ticketPresentation?.Secondary,
            "raffle ticket overlay omits cumulative pool details");
        Equal("추첨권을 드렸어요!", RaffleOverlayActionAdapter.TicketSpeechText,
            "frequent ticket grants use one fixed, nickname-free speech line");
        var fixedTicketAudio = ByeollogRaffleAudio.TicketAudioForPreflight();
        Equal(ByeollogRaffleAudio.TicketByteSize, fixedTicketAudio.Length,
            "fixed ticket speech keeps its sealed byte size");
        Equal(ByeollogRaffleAudio.TicketSha256,
            Convert.ToHexString(SHA256.HashData(fixedTicketAudio)).ToLowerInvariant(),
            "fixed ticket speech keeps its sealed hash");
        True(fixedTicketAudio.AsSpan(0, 4).SequenceEqual("RIFF"u8)
             && fixedTicketAudio.AsSpan(8, 4).SequenceEqual("WAVE"u8),
            "fixed ticket speech is a valid WAV resource");
        var winnerPreviewAudio = ByeollogRaffleAudio.WinnerFallbackAudioForPreflight();
        Equal(ByeollogRaffleAudio.WinnerFallbackByteSize, winnerPreviewAudio.Length,
            "winner volume preview reuses the current sealed fallback voice");
        Equal(ByeollogRaffleAudio.WinnerFallbackSha256,
            Convert.ToHexString(SHA256.HashData(winnerPreviewAudio)).ToLowerInvariant(),
            "winner volume preview cannot drift from the current fallback voice");

        using var drawJson = JsonDocument.Parse("""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":4000,"winnerCount":3,"winners":[{"drawIndex":1,"actorName":"하나"},{"drawIndex":2,"actorName":"둘"},{"drawIndex":3,"actorName":"셋"}]}""");
        True(RaffleOverlayActionAdapter.TryRead(drawJson.RootElement, out var drawKey, out _, out var drawPresentation, out _),
            "ordered raffle draw payload is accepted");
        Equal(OverlayAssetCache.RaffleDrawAssetKey, drawKey, "raffle draw payload selects only the draw GIF");
        Equal(3, drawPresentation?.WinnerNames.Count, "all ordered winners are shown on the overlay");
        Equal("", drawPresentation?.Secondary,
            "raffle draw overlay omits the congratulation subline");

        using var forged = JsonDocument.Parse("""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":4000,"winnerCount":2,"winners":[{"drawIndex":2,"actorName":"순서 위조"},{"drawIndex":1,"actorName":"거부"}]}""");
        False(RaffleOverlayActionAdapter.TryRead(forged.RootElement, out _, out _, out _, out _),
            "out-of-order raffle winners are rejected before display");
        using var manualDraw = JsonDocument.Parse("""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":4000,"winnerCount":1,"drawIndex":2,"winnerTarget":3,"winners":[{"drawIndex":2,"actorName":"두번째"}]}""");
        True(RaffleOverlayActionAdapter.TryRead(manualDraw.RootElement, out _, out _, out var manualPresentation, out _),
            "manual raffle draw accepts one bounded winner with absolute progress");
        Equal("두번째", manualPresentation!.WinnerNames.Single(),
            "manual raffle draw preserves the selected winner");
        using var staleManualDraw = JsonDocument.Parse("""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":4000,"winnerCount":1,"drawIndex":2,"winnerTarget":3,"winners":[{"drawIndex":1,"actorName":"순서 불일치"}]}""");
        False(RaffleOverlayActionAdapter.TryRead(staleManualDraw.RootElement, out _, out _, out _, out _),
            "manual raffle draw rejects a stale winner index");

        var ticketTimeoutJob = Job(
            "raffle-timeout-ticket",
            1,
            RaffleOverlayActionAdapter.ActionType,
            ticketJson.RootElement.GetRawText());
        Equal(
            TimedMuteContract.MaximumAccumulatedDurationMs + 5_000 + 30_000,
            RaffleOverlayActionAdapter.EffectiveTimeoutMs(
                ticketTimeoutJob.ActionParams,
                ticketTimeoutJob.TimeoutMs),
            "raffle ticket timeout includes a full queued Abong session plus its own display");
        using var testSequenceJson = JsonDocument.Parse("""{"kind":"test_sequence","ticketOverlayImageKey":"raffle_ticket_granted","ticketDurationMs":1000,"ticketOverlayPositionX":5000,"ticketOverlayPositionY":5000,"ticketOverlayScalePercent":100,"ticketVolumePercent":80,"drawOverlayImageKey":"raffle_draw","drawDurationMs":1000,"drawOverlayPositionX":5000,"drawOverlayPositionY":5000,"drawOverlayScalePercent":100,"drawVolumePercent":80}""");
        var testSequenceTimeoutJob = Job(
            "raffle-timeout-sequence",
            1,
            RaffleOverlayActionAdapter.ActionType,
            testSequenceJson.RootElement.GetRawText());
        Equal(
            TimedMuteContract.MaximumAccumulatedDurationMs + 2_000 + 30_000,
            RaffleOverlayActionAdapter.EffectiveTimeoutMs(
                testSequenceTimeoutJob.ActionParams,
                testSequenceTimeoutJob.TimeoutMs),
            "raffle test sequence timeout includes queued Abong and both presentations");
    }

    private static void FlashbangActionTests(string root)
    {
        var cache = new OverlayAssetCache(Path.Combine(root, "flashbang-overlay"));
        var cases = new[]
        {
            ("soft", OverlayAssetCache.FlashbangSoftAssetKey,
                OverlayAssetCache.FlashbangSoftContentSha256),
            ("standard", OverlayAssetCache.FlashbangStandardAssetKey,
                OverlayAssetCache.FlashbangStandardContentSha256),
            ("strong", OverlayAssetCache.FlashbangStrongAssetKey,
                OverlayAssetCache.FlashbangStrongContentSha256)
        };
        foreach (var (intensity, key, expectedHash) in cases)
        {
            True(cache.TryResolve(key, null, out var asset),
                $"{intensity} flashbang GIF resolves without network access");
            Equal("image/gif", asset.MimeType,
                $"{intensity} flashbang uses an animated GIF descriptor");
            Equal(1920, asset.WidthPx, $"{intensity} flashbang is authored for 1920 width");
            Equal(1080, asset.HeightPx, $"{intensity} flashbang is authored for 1080 height");
            Equal(expectedHash, asset.ContentSha256,
                $"{intensity} flashbang keeps its immutable SHA-256");
            True(cache.Read(asset).Bytes.AsSpan(0, 6).SequenceEqual("GIF89a"u8),
                $"{intensity} flashbang has a GIF89a header");

            using var json = JsonDocument.Parse($$"""{"intensity":"{{intensity}}","overlayImageKey":"{{key}}","durationMs":5000,"volumePercent":75}""");
            True(FlashbangOverlayActionAdapter.TryRead(
                    json.RootElement,
                    out var parsedIntensity,
                    out var parsedKey,
                    out var volumePercent,
                    out _),
                $"{intensity} flashbang payload passes the strict parser");
            Equal(intensity, parsedIntensity, "flashbang parser preserves intensity");
            Equal(key, parsedKey, "flashbang parser binds intensity to its exact packaged GIF");
            Equal(75, volumePercent, "flashbang parser preserves bounded Browser Source volume");
        }

        using var mismatched = JsonDocument.Parse(
            """{"intensity":"soft","overlayImageKey":"flashbang_strong","durationMs":5000,"volumePercent":75}""");
        False(FlashbangOverlayActionAdapter.TryRead(
                mismatched.RootElement, out _, out _, out _, out _),
            "flashbang rejects an intensity-to-asset mismatch");
        using var wrongDuration = JsonDocument.Parse(
            """{"intensity":"standard","overlayImageKey":"flashbang_standard","durationMs":3000,"volumePercent":75}""");
        False(FlashbangOverlayActionAdapter.TryRead(
                wrongDuration.RootElement, out _, out _, out _, out _),
            "flashbang rejects a duration outside the fixed five-second recovery");
        using var excessiveVolume = JsonDocument.Parse(
            """{"intensity":"strong","overlayImageKey":"flashbang_strong","durationMs":5000,"volumePercent":101}""");
        False(FlashbangOverlayActionAdapter.TryRead(
                excessiveVolume.RootElement, out _, out _, out _, out _),
            "flashbang rejects Browser Source volume above 100 percent");
        True(VNextAgentCapabilities.ForWindowsAgent().Contains(
                FlashbangOverlayActionAdapter.ActionType),
            "agent advertises the flashbang overlay capability");
    }

    private static async Task RaffleSpeechCacheTestsAsync(string root)
    {
        var embeddedFallback = ByeollogRaffleAudio.WinnerFallbackAudioForPreflight();
        Equal(ByeollogRaffleAudio.WinnerFallbackByteSize, embeddedFallback.Length,
            "embedded winner fallback has its pinned byte length");
        Equal(ByeollogRaffleAudio.WinnerFallbackSha256,
            Convert.ToHexString(SHA256.HashData(embeddedFallback)).ToLowerInvariant(),
            "embedded winner fallback has its pinned SHA-256");
        Equal("당첨을 축하드려요", ByeollogRaffleAudio.WinnerFallbackSpeechText,
            "embedded winner fallback documents the exact spoken phrase");
        ByeollogRaffleAudio.ValidateWinnerAudioForPreflight(embeddedFallback);

        Equal(2, RaffleWinnerSpeechCache.SchemaVersion,
            "winner speech cache generation is bumped for the CosyVoice model family");
        var cacheRoot = Path.Combine(root, "raffle-speech-cache");
        var logs = new List<string>();
        var cache = new RaffleWinnerSpeechCache(cacheRoot, logs.Add);
        var keyA = RaffleWinnerSpeechCache.ComputeVoiceKey("첫 번째 후보");
        var keyB = RaffleWinnerSpeechCache.ComputeVoiceKey("두 번째 후보");
        False(string.Equals(keyA, keyB, StringComparison.Ordinal),
            "different candidate names have different deterministic voice identities");
        var audioA = CreateTestWav(440);
        var audioB = CreateTestWav(660);
        var hashA = Convert.ToHexString(SHA256.HashData(audioA)).ToLowerInvariant();
        var hashB = Convert.ToHexString(SHA256.HashData(audioB)).ToLowerInvariant();
        await cache.StoreAsync(
            keyA,
            new RaffleWinnerSpeechDownload(audioA, keyA, "test-voice-v1", hashA));
        await cache.StoreAsync(
            keyB,
            new RaffleWinnerSpeechDownload(audioB, keyB, "test-voice-v1", hashB));
        True(cache.TryRead(keyA, out var cachedA) && cachedA is not null,
            "candidate A speech is readable only through candidate A voice key");
        Equal(hashA, cachedA!.AudioSha256,
            "candidate A cache retains the exact verified audio hash");

        var restarted = new RaffleWinnerSpeechCache(cacheRoot, logs.Add);
        True(restarted.TryRead(keyB, out var restartedB) && restartedB is not null,
            "verified candidate speech survives Agent restart on disk");
        Equal(hashB, restartedB!.AudioSha256,
            "restart cache lookup revalidates candidate B audio hash");

        File.Copy(
            Path.Combine(cacheRoot, keyA + ".wav"),
            Path.Combine(cacheRoot, keyB + ".wav"),
            overwrite: true);
        False(restarted.TryRead(keyB, out _),
            "candidate A audio swapped into candidate B cache is rejected before playback");
        True(logs.Any(item => item.Contains(keyB[..12], StringComparison.Ordinal)),
            "mixed candidate cache emits a non-PII identity diagnostic");

        await restarted.StoreAsync(
            keyB,
            new RaffleWinnerSpeechDownload(audioB, keyB, "test-voice-v1", hashB));
        var manifestPath = Path.Combine(cacheRoot, keyB + ".json");
        var manifest = File.ReadAllText(manifestPath, Encoding.UTF8)
            .Replace(keyB, keyA, StringComparison.Ordinal);
        File.WriteAllText(manifestPath, manifest, new UTF8Encoding(false));
        False(restarted.TryRead(keyB, out _),
            "manifest claiming another candidate voice key is rejected before playback");

        await restarted.StoreAsync(
            keyB,
            new RaffleWinnerSpeechDownload(audioB, keyB, "test-voice-v1", hashB));
        var audioPath = Path.Combine(cacheRoot, keyB + ".wav");
        var tamperedAudio = File.ReadAllBytes(audioPath);
        tamperedAudio[^2] ^= 0x01;
        File.WriteAllBytes(audioPath, tamperedAudio);
        False(restarted.TryRead(keyB, out _),
            "tampered candidate audio is rejected even when its manifest is untouched");
    }

    private static byte[] CreateTestWav(int frequency)
    {
        using var memory = new MemoryStream();
        using (var writer = new WaveFileWriter(memory, new WaveFormat(16_000, 16, 1)))
        {
            const int samples = 3_200;
            for (var index = 0; index < samples; index++)
            {
                var sample = (short)(Math.Sin(2 * Math.PI * frequency * index / 16_000d) * 2_500);
                writer.WriteByte((byte)(sample & 0xff));
                writer.WriteByte((byte)((sample >> 8) & 0xff));
            }
        }
        return memory.ToArray();
    }

    private static void ActionFreshnessTests()
    {
        var now = new DateTimeOffset(2026, 8, 24, 12, 0, 0, TimeSpan.Zero);
        using var future = JsonDocument.Parse("""{"target":"microphone","durationMs":10000,"notAfterUtc":"2026-08-24T12:00:30Z"}""");
        Equal(
            VNextActionFreshnessStatus.Fresh,
            VNextActionFreshness.ValidateAndStrip(
                future.RootElement,
                now,
                out var stripped,
                out var freshError),
            "a bounded future action passes the common pre-side-effect freshness guard");
        Equal("", freshError, "fresh action has no user-facing error");
        False(stripped.TryGetProperty("notAfterUtc", out _),
            "freshness metadata is stripped before strict action-specific parsing");
        True(TimedMuteContract.TryReadObsParameters(stripped, out var durationMs, out _),
            "stripped timed-mute parameters retain their strict action contract");
        Equal(10_000, durationMs, "freshness stripping preserves the exact action duration");

        using var expired = JsonDocument.Parse("""{"kind":"ticket_granted","notAfterUtc":"2026-08-24T11:59:59.999999Z"}""");
        Equal(
            VNextActionFreshnessStatus.Expired,
            VNextActionFreshness.ValidateAndStrip(
                expired.RootElement,
                now,
                out _,
                out var expiredError),
            "an expired action is rejected before any adapter side effect");
        True(expiredError.Contains("지난", StringComparison.Ordinal),
            "expired action failure is explicit and non-transient");

        using var invalid = JsonDocument.Parse("""{"kind":"ticket_granted","notAfterUtc":"tomorrow"}""");
        Equal(
            VNextActionFreshnessStatus.Invalid,
            VNextActionFreshness.ValidateAndStrip(
                invalid.RootElement,
                now,
                out _,
                out _),
            "non-ISO action expiry fails closed");
        using var duplicate = JsonDocument.Parse("""{"kind":"ticket_granted","notAfterUtc":"2026-08-24T12:00:30Z","notAfterUtc":"2026-08-24T12:00:31Z"}""");
        Equal(
            VNextActionFreshnessStatus.Invalid,
            VNextActionFreshness.ValidateAndStrip(
                duplicate.RootElement,
                now,
                out _,
                out _),
            "duplicate expiry metadata fails closed instead of trusting the last JSON property");
    }

    private static async Task RaffleRuntimeSafetyTestsAsync(string root)
    {
        using var ticketJson = JsonDocument.Parse("""{"kind":"ticket_granted","overlayImageKey":"raffle_ticket_granted","durationMs":1000,"actorName":"테스터","ticketsGranted":1,"actorTickets":1,"totalTickets":1,"participantCount":1,"overlayPositionX":5000,"overlayPositionY":5000,"overlayScalePercent":100,"volumePercent":80}""");

        var unavailableCache = new OverlayAssetCache(Path.Combine(root, "raffle-runtime-unavailable"));
        using (var unavailableService = new ByeollogOverlayService(
            new CollectorStorage(),
            unavailableCache,
            AvailableLoopbackPort()))
        {
            True(unavailableService.TryStart(), "raffle unavailable fixture starts its loopback service");
            var unavailableSpeechCalls = 0;
            var unavailableAdapter = new RaffleOverlayActionAdapter(
                unavailableService,
                prepareTicketSpeech: (_, _) =>
                {
                    Interlocked.Increment(ref unavailableSpeechCalls);
                    return Task.FromResult(PreparedTestAudio(
                        RaffleOverlayActionAdapter.TicketAudioBindingKey));
                });
            var unavailable = await unavailableAdapter.ExecuteAsync(
                "11111111-1111-4111-8111-111111111111",
                1,
                ticketJson.RootElement,
                CancellationToken.None);
            False(unavailable.Succeeded, "raffle fails before side effects when no OBS Browser Source is polling");
            True(unavailable.Retryable, "missing Browser Source readiness is retryable before side effects");
            Equal(0, unavailableSpeechCalls, "TTS never starts without current-document Browser Source proof");
            False(unavailableService.Snapshot().Active, "failed readiness leaves no active raffle presentation");
        }

        var readyCache = new OverlayAssetCache(Path.Combine(root, "raffle-runtime-ready"));
        using var readyService = new ByeollogOverlayService(
            new CollectorStorage(),
            readyCache,
            AvailableLoopbackPort());
        True(readyService.TryStart(), "raffle ready fixture starts its loopback service");
        using var pollStop = new CancellationTokenSource();
        var observedAudioStates = new ConcurrentQueue<ByeollogOverlaySnapshot>();
        var delayedAudioPrimary = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        var polling = PollCurrentOverlayDocumentAsync(
            readyService,
            pollStop.Token,
            observedAudioStates,
            snapshot => snapshot.PresentationPrimary is not null
                && delayedAudioPrimary.ContainsKey(snapshot.PresentationPrimary)
                    ? TimeSpan.FromMilliseconds(4_800)
                    : TimeSpan.Zero);
        True(
            await readyService.WaitForCurrentDocumentBrowserSourceAsync(
                TimeSpan.FromSeconds(2),
                CancellationToken.None),
            "current overlay HTML revision proves live Browser Source readiness");

        var speechCalls = 0;
        var speechSawActiveRaffle = false;
        var winnerPreparationStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWinnerPreparation = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var blockWinnerPreparation = false;
        var winnerPreparationSawInactiveOverlay = false;
        var winnerPlaybackSawActiveDraw = false;
        var adapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareTicketSpeech: (_, _) =>
            {
                Interlocked.Increment(ref speechCalls);
                return Task.FromResult(PreparedTestAudio(
                    RaffleOverlayActionAdapter.TicketAudioBindingKey));
            },
            prepareWinnerSpeech: async (_, _, _, expectedVoiceKey, _, token) =>
            {
                True(expectedVoiceKey.Length == 64,
                    "winner preparation receives the exact server-bound voice identity");
                if (blockWinnerPreparation)
                {
                    winnerPreparationSawInactiveOverlay = !readyService.Snapshot().Active;
                    winnerPreparationStarted.TrySetResult(true);
                    await releaseWinnerPreparation.Task.WaitAsync(token);
                }
                Interlocked.Increment(ref speechCalls);
                return PreparedTestAudio(expectedVoiceKey);
            });
        var outcome = await adapter.ExecuteAsync(
            "11111111-1111-4111-8111-111111111111",
            1,
            ticketJson.RootElement,
            CancellationToken.None);
        True(outcome.Succeeded, "raffle succeeds with a live current-document Browser Source");
        Equal(1, speechCalls, "one successful ticket presentation speaks exactly once");
        speechSawActiveRaffle = observedAudioStates.Any(snapshot =>
            snapshot.AssetKey == OverlayAssetCache.RaffleTicketGrantedAssetKey
            && snapshot.AudioPresentationRevision == snapshot.Revision);
        True(speechSawActiveRaffle, "OBS Browser Source requests ticket audio only for its active presentation");
        var outcomeJson = JsonSerializer.SerializeToElement(outcome.Result);
        var evidence = outcomeJson.GetProperty("overlayEvidence")[0];
        True(evidence.GetProperty("Overlay").GetProperty("ActiveStateRequestDelta").GetInt64() > 0,
            "raffle success result carries positive active-state polling evidence");
        True(outcomeJson.GetProperty("speechAttempted").GetBoolean(),
            "raffle success records that speech was attempted");
        True(outcomeJson.GetProperty("ttsPlayed").GetBoolean(),
            "raffle success records successful TTS truthfully");

        var liveWinnerVoiceKey = RaffleWinnerSpeechCache.ComputeVoiceKey("당첨자");
        using var liveDrawJson = JsonDocument.Parse($$"""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":1000,"winnerCount":1,"drawIndex":1,"winnerTarget":1,"winners":[{"drawIndex":1,"actorName":"당첨자","voiceKey":"{{liveWinnerVoiceKey}}"}],"overlayPositionX":5000,"overlayPositionY":5000,"overlayScalePercent":100,"volumePercent":80}""");
        var speechBeforeDraw = speechCalls;
        blockWinnerPreparation = true;
        var liveDrawTask = adapter.ExecuteAsync(
            "22222222-2222-4222-8222-222222222222",
            1,
            liveDrawJson.RootElement,
            CancellationToken.None);
        await winnerPreparationStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        True(winnerPreparationSawInactiveOverlay,
            "winner audio preparation starts before the draw overlay is made active");
        False(readyService.Snapshot().Active,
            "draw overlay remains hidden while server winner audio is being prepared");
        await Task.Delay(150);
        False(readyService.Snapshot().Active,
            "slow winner synthesis cannot expose an early silent draw screen");
        blockWinnerPreparation = false;
        releaseWinnerPreparation.TrySetResult(true);
        var liveDrawOutcome = await liveDrawTask.WaitAsync(TimeSpan.FromSeconds(3));
        True(liveDrawOutcome.Succeeded,
            "one-winner draw_result completes through the observed overlay and TTS runtime path");
        Equal(speechBeforeDraw + 1, speechCalls,
            "one-winner draw_result speaks exactly once");
        winnerPlaybackSawActiveDraw = observedAudioStates.Any(snapshot =>
            snapshot.AssetKey == OverlayAssetCache.RaffleDrawAssetKey
            && snapshot.AudioPresentationRevision == snapshot.Revision);
        True(winnerPlaybackSawActiveDraw,
            "prepared winner audio is bound to the observed draw presentation");
        var liveDrawResult = JsonSerializer.SerializeToElement(liveDrawOutcome.Result);
        Equal("raffle_draw",
            liveDrawResult.GetProperty("overlayEvidence")[0]
                .GetProperty("Overlay").GetProperty("AssetKey").GetString(),
            "draw_result ACK evidence is bound to the draw GIF");

        var missingIdentitySpeechCalls = 0;
        var visualOnlyAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareWinnerSpeech: (_, _, _, _, _, _) =>
            {
                Interlocked.Increment(ref missingIdentitySpeechCalls);
                throw new InvalidOperationException("missing identity must not call speech");
            });
        using var missingIdentityDraw = JsonDocument.Parse("""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":1000,"winnerCount":1,"drawIndex":1,"winnerTarget":1,"winners":[{"drawIndex":1,"actorName":"키 없는 당첨자"}],"overlayPositionX":5000,"overlayPositionY":5000,"overlayScalePercent":100,"volumePercent":80}""");
        var visualOnlyOutcome = await visualOnlyAdapter.ExecuteAsync(
            "28282828-2828-4828-8828-282828282828",
            1,
            missingIdentityDraw.RootElement,
            CancellationToken.None);
        True(visualOnlyOutcome.Succeeded,
            "legacy draw without a bound voice key remains visually deliverable");
        Equal(0, missingIdentitySpeechCalls,
            "draw without an exact voice identity never guesses or fetches winner speech");

        var anotherCandidateKey = RaffleWinnerSpeechCache.ComputeVoiceKey("다른 후보");
        using var mismatchedIdentityDraw = JsonDocument.Parse($$"""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":1000,"winnerCount":1,"drawIndex":1,"winnerTarget":1,"winners":[{"drawIndex":1,"actorName":"실제 당첨자","voiceKey":"{{anotherCandidateKey}}"}],"overlayPositionX":5000,"overlayPositionY":5000,"overlayScalePercent":100,"volumePercent":80}""");
        var mismatchedIdentityOutcome = await visualOnlyAdapter.ExecuteAsync(
            "29292929-2929-4929-8929-292929292929",
            1,
            mismatchedIdentityDraw.RootElement,
            CancellationToken.None);
        True(mismatchedIdentityOutcome.Succeeded,
            "draw with another candidate voice key preserves its visual result");
        Equal(0, missingIdentitySpeechCalls,
            "another candidate voice key is rejected locally instead of playing mixed speech");

        using var liveSequenceJson = JsonDocument.Parse("""{"kind":"test_sequence","ticketOverlayImageKey":"raffle_ticket_granted","ticketDurationMs":1000,"ticketOverlayPositionX":5000,"ticketOverlayPositionY":5000,"ticketOverlayScalePercent":100,"ticketVolumePercent":80,"drawOverlayImageKey":"raffle_draw","drawDurationMs":1000,"drawOverlayPositionX":5000,"drawOverlayPositionY":5000,"drawOverlayScalePercent":100,"drawVolumePercent":80}""");
        var speechBeforeSequence = speechCalls;
        var observedBeforeSequence = observedAudioStates.Count;
        var liveSequenceOutcome = await adapter.ExecuteAsync(
            "33333333-3333-4333-8333-333333333333",
            1,
            liveSequenceJson.RootElement,
            CancellationToken.None);
        True(liveSequenceOutcome.Succeeded,
            "test_sequence completes both observed presentations through the runtime path");
        Equal(speechBeforeSequence + 2, speechCalls,
            "test_sequence speaks once for ticket grant and once for the draw");
        var liveSequenceResult = JsonSerializer.SerializeToElement(liveSequenceOutcome.Result);
        Equal(2, liveSequenceResult.GetProperty("overlayEvidence").GetArrayLength(),
            "test_sequence ACK carries independent evidence for both presentations");
        Equal("raffle_ticket_granted",
            liveSequenceResult.GetProperty("overlayEvidence")[0]
                .GetProperty("Overlay").GetProperty("AssetKey").GetString(),
            "test_sequence first evidence is the ticket GIF");
        Equal("raffle_draw",
            liveSequenceResult.GetProperty("overlayEvidence")[1]
                .GetProperty("Overlay").GetProperty("AssetKey").GetString(),
            "test_sequence second evidence is the draw GIF");
        var sequenceAudioStates = observedAudioStates.ToArray().Skip(observedBeforeSequence).ToArray();
        Equal(2, sequenceAudioStates.Length,
            "test_sequence publishes one exact OBS audio payload per presentation");
        Equal("테스트 시청자님, 추첨권 1장!",
            sequenceAudioStates[0].PresentationPrimary,
            "test_sequence ticket primary copy is identical to production formatting");
        Equal("",
            sequenceAudioStates[0].PresentationSecondary,
            "test_sequence omits ticket cumulative details like production");
        True(liveSequenceResult.GetProperty("overlayEvidence")[0]
                .GetProperty("Audio").GetProperty("Ended").GetBoolean()
            && liveSequenceResult.GetProperty("overlayEvidence")[1]
                .GetProperty("Audio").GetProperty("Ended").GetBoolean(),
            "test_sequence ACK requires browser-ended evidence for both OBS audio clips");

        const string longWinnerName = "긴 음성 당첨자";
        const string longWinnerPrimary = "긴 음성 당첨자님 당첨!";
        delayedAudioPrimary.TryAdd(longWinnerPrimary, 0);
        var longWinnerKey = RaffleWinnerSpeechCache.ComputeVoiceKey(longWinnerName);
        using var longWinnerJson = JsonDocument.Parse($$"""{"kind":"draw_result","overlayImageKey":"raffle_draw","durationMs":4000,"winnerCount":1,"drawIndex":1,"winnerTarget":1,"winners":[{"drawIndex":1,"actorName":"{{longWinnerName}}","voiceKey":"{{longWinnerKey}}"}],"overlayPositionX":5000,"overlayPositionY":5000,"overlayScalePercent":100,"volumePercent":80}""");
        var longAudioAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareWinnerSpeech: (_, _, _, expectedVoiceKey, _, _) =>
                Task.FromResult(PreparedTestAudio(expectedVoiceKey)));
        var observedBeforeLongAudio = observedAudioStates.Count;
        var longAudioRun = longAudioAdapter.ExecuteAsync(
            "34343434-3434-4434-8434-343434343434",
            1,
            longWinnerJson.RootElement,
            CancellationToken.None);
        var longAudioWaitDeadline = DateTimeOffset.UtcNow.AddSeconds(2);
        while (observedAudioStates.Count == observedBeforeLongAudio
            && DateTimeOffset.UtcNow < longAudioWaitDeadline)
            await Task.Delay(20);
        Equal(observedBeforeLongAudio + 1, observedAudioStates.Count,
            "long winner audio is published exactly once to the OBS document");
        var longAudioState = observedAudioStates.ToArray()[observedBeforeLongAudio];
        Equal(longWinnerPrimary, longAudioState.PresentationPrimary,
            "long audio timing test is bound to the intended winner presentation");
        var longAudioClock = Stopwatch.StartNew();
        await Task.Delay(4_100);
        var heldSnapshot = readyService.Snapshot();
        True(heldSnapshot.Active
            && heldSnapshot.Revision == longAudioState.Revision
            && heldSnapshot.AudioToken == longAudioState.AudioToken,
            "winner overlay remains visible after its configured four seconds while OBS audio is still playing");

        using (var bindingHttp = new HttpClient(new HttpClientHandler { UseProxy = false }))
        {
            var wrongHash = new string('0', 64);
            var wrongAudioUrl = $"{readyService.OverlayUrl}/audio/{longAudioState.AudioToken}?revision={wrongHash}&presentationRevision={longAudioState.Revision}";
            using var wrongAudio = await bindingHttp.GetAsync(wrongAudioUrl);
            Equal(HttpStatusCode.NotFound, wrongAudio.StatusCode,
                "active OBS audio endpoint rejects a mismatched content hash");
            var wrongRevisionUrl = $"{readyService.OverlayUrl}/audio/{longAudioState.AudioToken}?revision={longAudioState.AudioContentSha256}&presentationRevision={longAudioState.Revision + 1}";
            using var wrongRevision = await bindingHttp.GetAsync(wrongRevisionUrl);
            Equal(HttpStatusCode.NotFound, wrongRevision.StatusCode,
                "active OBS audio endpoint rejects another presentation revision");
        }

        var longAudioOutcome = await longAudioRun.WaitAsync(TimeSpan.FromSeconds(2));
        True(longAudioOutcome.Succeeded,
            "winner action succeeds after OBS reports the long audio ended");
        True(longAudioClock.Elapsed >= TimeSpan.FromMilliseconds(4_650),
            "winner action does not finish before the longer browser audio ends");
        False(readyService.Snapshot().Active,
            "winner overlay hides promptly once both minimum display time and OBS audio are complete");
        using (var staleHttp = new HttpClient(new HttpClientHandler { UseProxy = false }))
        {
            var staleUrl = $"{readyService.OverlayUrl}/audio/{longAudioState.AudioToken}?revision={longAudioState.AudioContentSha256}&presentationRevision={longAudioState.Revision}";
            using var staleAudio = await staleHttp.GetAsync(staleUrl);
            Equal(HttpStatusCode.NotFound, staleAudio.StatusCode,
                "completed presentation audio token cannot be replayed by a stale OBS document");
        }

        var wrongPreparedBinding = RaffleWinnerSpeechCache.ComputeVoiceKey("다른 음성 대상");
        var wrongPreparedAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareWinnerSpeech: (_, _, _, _, _, _) =>
                Task.FromResult(PreparedTestAudio(wrongPreparedBinding)));
        var observedBeforeWrongPrepared = observedAudioStates.Count;
        var wrongPreparedOutcome = await wrongPreparedAdapter.ExecuteAsync(
            "35353535-3535-4535-8535-353535353535",
            1,
            liveDrawJson.RootElement,
            CancellationToken.None);
        True(wrongPreparedOutcome.Succeeded,
            "wrongly bound prepared winner speech cannot erase the visual draw result");
        var wrongPreparedResult = JsonSerializer.SerializeToElement(wrongPreparedOutcome.Result);
        False(wrongPreparedResult.GetProperty("ttsPlayed").GetBoolean(),
            "wrongly bound winner speech is never reported as played");
        Equal(observedBeforeWrongPrepared, observedAudioStates.Count,
            "wrongly bound winner speech is never disclosed to the OBS Browser Source");

        var fallbackAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareWinnerSpeech: (_, _, _, expectedVoiceKey, _, _) =>
                Task.FromResult(new RafflePreparedAudio(
                    ByeollogRaffleAudio.WinnerFallbackAudioForPreflight(),
                    ByeollogRaffleAudio.WinnerFallbackSha256,
                    expectedVoiceKey,
                    "embedded_fallback",
                    "HttpRequestException")));
        var observedBeforeFallback = observedAudioStates.Count;
        var fallbackOutcome = await fallbackAdapter.ExecuteAsync(
            "36363636-3636-4636-8636-363636363636",
            1,
            liveDrawJson.RootElement,
            CancellationToken.None);
        True(fallbackOutcome.Succeeded,
            "offline custom winner speech falls back to the embedded generic announcement");
        Equal(observedBeforeFallback + 1, observedAudioStates.Count,
            "embedded fallback is published once through the Browser Source audio path");
        var fallbackJson = JsonSerializer.SerializeToElement(fallbackOutcome.Result);
        var fallbackEvidence = fallbackJson.GetProperty("overlayEvidence")[0];
        True(fallbackJson.GetProperty("ttsPlayed").GetBoolean(),
            "embedded fallback requires browser-ended evidence before reporting TTS success");
        Equal("embedded_fallback", fallbackEvidence.GetProperty("TtsSource").GetString(),
            "fallback use is recorded separately from custom winner speech");
        Equal("HttpRequestException", fallbackEvidence.GetProperty("TtsFallbackReason").GetString(),
            "fallback evidence retains only the bounded failure type");
        Equal(ByeollogRaffleAudio.WinnerFallbackSha256,
            observedAudioStates.ToArray()[observedBeforeFallback].AudioContentSha256,
            "generic fallback publishes only the byte-pinned embedded audio");
        Equal("당첨자님 당첨!",
            observedAudioStates.ToArray()[observedBeforeFallback].PresentationPrimary,
            "generic fallback remains attached to the exact winning presentation");

        var ttsFailureLogs = new List<string>();
        var ttsFailureAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareTicketSpeech: (_, _) => throw new IOException("simulated TTS failure"),
            log: message => ttsFailureLogs.Add(message));
        var ttsFailureOutcome = await ttsFailureAdapter.ExecuteAsync(
            "44444444-4444-4444-8444-444444444444",
            1,
            ticketJson.RootElement,
            CancellationToken.None);
        True(ttsFailureOutcome.Succeeded,
            "a TTS-only failure does not erase a proven visual raffle presentation");
        var ttsFailureJson = JsonSerializer.SerializeToElement(ttsFailureOutcome.Result);
        True(ttsFailureJson.GetProperty("speechAttempted").GetBoolean(),
            "failed TTS remains recorded as attempted");
        False(ttsFailureJson.GetProperty("ttsPlayed").GetBoolean(),
            "failed TTS is never reported as played");
        True(ttsFailureLogs.Any(message => message.Contains("IOException", StringComparison.Ordinal)),
            "failed TTS emits a bounded diagnostic type for support records");

        var abongSideEffectStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var abong = readyService.ShowSynchronizedAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            placement: null,
            async (onActivated, token) =>
            {
                True(readyService.Snapshot().Active,
                    "Abong side effect starts only after its overlay is active");
                onActivated();
                abongSideEffectStarted.TrySetResult(true);
                await Task.Delay(1_000, token);
                return true;
            },
            CancellationToken.None);
        await abongSideEffectStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var queuedSpeechCalls = 0;
        var queuedSpeechSawRaffle = false;
        var queuedAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareTicketSpeech: (_, _) =>
            {
                Interlocked.Increment(ref queuedSpeechCalls);
                return Task.FromResult(PreparedTestAudio(
                    RaffleOverlayActionAdapter.TicketAudioBindingKey));
            });
        var observedBeforeQueued = observedAudioStates.Count;
        var queuedRaffle = queuedAdapter.ExecuteAsync(
            "55555555-5555-4555-8555-555555555555",
            1,
            ticketJson.RootElement,
            CancellationToken.None);
        await Task.Delay(250);
        Equal(observedBeforeQueued, observedAudioStates.Count,
            "raffle OBS audio remains undisclosed while queued behind an active Abong presentation");
        await abong.WaitAsync(TimeSpan.FromSeconds(3));
        var queuedOutcome = await queuedRaffle.WaitAsync(TimeSpan.FromSeconds(3));
        True(queuedOutcome.Succeeded, "queued raffle starts cleanly after Abong releases the shared overlay gate");
        Equal(1, queuedSpeechCalls, "queued raffle audio is prepared exactly once");
        queuedSpeechSawRaffle = observedAudioStates.Any(snapshot =>
            snapshot.AssetKey == OverlayAssetCache.RaffleTicketGrantedAssetKey
            && snapshot.AudioPresentationRevision == snapshot.Revision);
        True(queuedSpeechSawRaffle, "queued TTS is synchronized with the raffle asset, not the preceding Abong");

        var failedBeforeActivation = readyService.ShowSynchronizedAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            placement: null,
            (_, _) => Task.FromException<bool>(
                new InvalidOperationException("simulated microphone activation failure")),
            CancellationToken.None);
        await ThrowsAsync<InvalidOperationException>(
            async () => await failedBeforeActivation.WaitAsync(TimeSpan.FromSeconds(2)),
            "an Abong side effect that fails before activation releases the shared overlay leader promptly");
        False(readyService.Snapshot().Active,
            "a failed pre-activation side effect cannot leave the overlay stuck active");

        var expiryAbongStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var expiryAbong = readyService.ShowSynchronizedAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            placement: null,
            async (onActivated, token) =>
            {
                onActivated();
                expiryAbongStarted.TrySetResult(true);
                await Task.Delay(1_000, token);
                return true;
            },
            CancellationToken.None);
        await expiryAbongStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var expiredQueuedSpeechCalls = 0;
        var expiredQueuedAdapter = new RaffleOverlayActionAdapter(
            readyService,
            prepareTicketSpeech: (_, _) =>
            {
                Interlocked.Increment(ref expiredQueuedSpeechCalls);
                return Task.FromResult(PreparedTestAudio(
                    RaffleOverlayActionAdapter.TicketAudioBindingKey));
            });
        var observedBeforeExpiredQueued = observedAudioStates.Count;
        var expiredQueuedRaffle = expiredQueuedAdapter.ExecuteAsync(
            "66666666-6666-4666-8666-666666666666",
            1,
            ticketJson.RootElement,
            CancellationToken.None,
            DateTimeOffset.UtcNow.AddMilliseconds(150));
        var expiryWait = Stopwatch.StartNew();
        var expiredQueuedOutcome = await expiredQueuedRaffle.WaitAsync(TimeSpan.FromSeconds(1));
        True(expiryWait.Elapsed < TimeSpan.FromMilliseconds(800),
            "raffle deadline cancels the shared-gate wait instead of occupying the Agent until Abong ends");
        False(expiryAbong.IsCompleted,
            "deadline cancellation does not interrupt the already active Abong session");
        await expiryAbong.WaitAsync(TimeSpan.FromSeconds(3));
        False(expiredQueuedOutcome.Succeeded,
            "raffle that expires while queued behind Abong is blocked before presentation");
        False(expiredQueuedOutcome.Retryable,
            "expired queued raffle is a terminal stale-event decision, not a retry loop");
        Equal(observedBeforeExpiredQueued, observedAudioStates.Count,
            "expired queued raffle never exposes OBS audio after the shared gate opens");
        Equal(1, expiredQueuedSpeechCalls,
            "expired queued raffle may prepare immutable local audio but never publishes it");

        var blockingTransientStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var blockingTransient = readyService.ShowObservedTransientAsync(
            OverlayAssetCache.RaffleTicketGrantedAssetKey,
            1_000,
            new RaffleOverlayPresentation(
                "ticket_granted",
                "만료 가드 테스트",
                "테스트 시청자님, 추첨권 1장!",
                "",
                Array.Empty<string>()),
            placement: null,
            async token =>
            {
                blockingTransientStarted.TrySetResult(true);
                await Task.Delay(1_000, token);
                return true;
            },
            CancellationToken.None);
        await blockingTransientStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var expiredMuteSideEffects = 0;
        var expiredMute = readyService.ShowSynchronizedAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            placement: null,
            async (onActivated, token) =>
            {
                Interlocked.Increment(ref expiredMuteSideEffects);
                onActivated();
                await Task.Delay(1_000, token);
                return true;
            },
            CancellationToken.None,
            notAfterUtc: DateTimeOffset.UtcNow.AddMilliseconds(150));
        await blockingTransient.WaitAsync(TimeSpan.FromSeconds(3));
        await ThrowsAsync<VNextActionExpiredException>(
            async () => await expiredMute.WaitAsync(TimeSpan.FromSeconds(3)),
            "an Abong expiring behind another overlay is blocked before muting");
        Equal(0, expiredMuteSideEffects,
            "expired queued Abong never starts its microphone side effect");

        var flashAudioBefore = observedAudioStates.Count;
        var flashbang = new FlashbangOverlayActionAdapter(
            readyService,
            ensureBrowserAudioRouting: _ => Task.FromResult(true));
        using var flashbangJson = JsonDocument.Parse(
            """{"intensity":"strong","overlayImageKey":"flashbang_strong","durationMs":5000,"volumePercent":60}""");
        var flashbangRun = Stopwatch.StartNew();
        var flashbangOutcome = await flashbang.ExecuteAsync(
            flashbangJson.RootElement,
            CancellationToken.None);
        True(flashbangOutcome.Succeeded,
            "strong flashbang completes only after a live Browser Source observes its presentation and sound");
        True(flashbangRun.Elapsed >= TimeSpan.FromMilliseconds(4_850),
            "flashbang remains a five-second recovery instead of ending before its audio and visual fade");
        var flashStates = observedAudioStates.ToArray().Skip(flashAudioBefore).ToArray();
        Equal(1, flashStates.Length,
            "flashbang publishes one exact Browser Source audio payload");
        Equal(OverlayAssetCache.FlashbangStrongAssetKey, flashStates[0].AssetKey,
            "strong selection is bound to the strong full-screen GIF at runtime");
        Equal(60, flashStates[0].AudioVolumePercent,
            "flashbang Browser Source receives the streamer-selected volume");
        var flashResult = JsonSerializer.SerializeToElement(flashbangOutcome.Result);
        True(flashResult.GetProperty("overlayDisplayed").GetBoolean()
             && flashResult.GetProperty("beepPlayed").GetBoolean(),
            "flashbang ACK proves both the observed full-screen overlay and ended beep");

        pollStop.Cancel();
        try { await polling; } catch (OperationCanceledException) { }
    }

    private static async Task PollCurrentOverlayDocumentAsync(
        ByeollogOverlayService service,
        CancellationToken cancellationToken,
        ConcurrentQueue<ByeollogOverlaySnapshot>? observedAudioStates = null,
        Func<ByeollogOverlaySnapshot, TimeSpan>? audioEndDelay = null)
    {
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
        var stateUrl = $"{service.OverlayUrl}/state?documentRevision={Uri.EscapeDataString(ByeollogOverlayService.DocumentRevision)}";
        var handledAudio = new HashSet<string>(StringComparer.Ordinal);
        var handledAssets = new HashSet<string>(StringComparer.Ordinal);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var response = await http.GetAsync(stateUrl, cancellationToken);
                response.EnsureSuccessStatusCode();
                var snapshot = JsonSerializer.Deserialize<ByeollogOverlaySnapshot>(
                    await response.Content.ReadAsByteArrayAsync(cancellationToken),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (snapshot is not null
                    && snapshot.Active
                    && snapshot.AssetToken is not null
                    && snapshot.ContentSha256 is not null)
                {
                    var assetIdentity = snapshot.AssetToken + ":"
                        + snapshot.ContentSha256 + ":" + snapshot.Revision;
                    if (handledAssets.Add(assetIdentity))
                    {
                        var flashbang = snapshot.AssetKey is
                            OverlayAssetCache.FlashbangSoftAssetKey or
                            OverlayAssetCache.FlashbangStandardAssetKey or
                            OverlayAssetCache.FlashbangStrongAssetKey;
                        var assetUrl = $"{service.OverlayUrl}/assets/{Uri.EscapeDataString(snapshot.AssetToken)}"
                            + $"?revision={Uri.EscapeDataString(snapshot.ContentSha256)}"
                            + (flashbang ? $"&presentationRevision={snapshot.Revision}" : "");
                        using var assetResponse = await http.GetAsync(assetUrl, cancellationToken);
                        assetResponse.EnsureSuccessStatusCode();
                        True((await assetResponse.Content.ReadAsByteArrayAsync(cancellationToken)).Length > 0,
                            "OBS Browser Source can fetch the exact active image binding");
                    }
                }
                if (snapshot is not null
                    && snapshot.Active
                    && snapshot.AudioToken is not null
                    && snapshot.AudioContentSha256 is not null
                    && snapshot.AudioPresentationRevision is not null)
                {
                    var identity = snapshot.AudioToken + ":"
                        + snapshot.AudioContentSha256 + ":"
                        + snapshot.AudioPresentationRevision.Value;
                    if (handledAudio.Add(identity))
                    {
                        observedAudioStates?.Enqueue(snapshot);
                        var binding = "revision="
                            + Uri.EscapeDataString(snapshot.AudioContentSha256)
                            + "&presentationRevision="
                            + snapshot.AudioPresentationRevision.Value.ToString(
                                System.Globalization.CultureInfo.InvariantCulture);
                        var audioUrl = $"{service.OverlayUrl}/audio/{Uri.EscapeDataString(snapshot.AudioToken)}?{binding}";
                        using var audioResponse = await http.GetAsync(audioUrl, cancellationToken);
                        audioResponse.EnsureSuccessStatusCode();
                        True((await audioResponse.Content.ReadAsByteArrayAsync(cancellationToken)).Length >= 44,
                            "OBS Browser Source can fetch only the active bound WAV payload");
                        var eventBase = $"{service.OverlayUrl}/audio-events/{Uri.EscapeDataString(snapshot.AudioToken)}";
                        using var started = await http.GetAsync(eventBase + "/started?" + binding, cancellationToken);
                        started.EnsureSuccessStatusCode();
                        var delay = audioEndDelay?.Invoke(snapshot) ?? TimeSpan.Zero;
                        if (delay > TimeSpan.Zero)
                            await Task.Delay(delay, cancellationToken);
                        using var ended = await http.GetAsync(eventBase + "/ended?" + binding, cancellationToken);
                        ended.EnsureSuccessStatusCode();
                    }
                }
            }
            catch (HttpRequestException) when (!cancellationToken.IsCancellationRequested)
            {
                // The loopback listener may need one scheduling turn after TryStart.
            }
            await Task.Delay(40, cancellationToken);
        }
    }

    private static void ReplayAcceptanceTests()
    {
        const string success = """{"name":"recorded-success","sourceUid":"replay-success-1","actionType":"obs.mute_for","durationMs":10000,"overlayAssetKey":"mic_off","deliveryCount":3,"assetHashValid":true,"muteVerified":true,"restoreVerified":true,"overlayDisplayed":true,"overlayHidden":true,"ackSent":true,"recoveryJournalEmpty":true,"expectedOutcome":"pass"}""";
        var passed = CollectorReplayAcceptance.Evaluate(CollectorReplayAcceptance.Parse(success));
        Equal("pass", passed.State, "recorded success replay passes without a live event");
        Equal(1, passed.Executions, "redelivery replay executes exactly once");
        True(passed.DuplicateBlocked, "redelivery replay blocks duplicates");

        const string restoreFailure = """{"name":"restore-failure","sourceUid":"replay-failure-1","actionType":"obs.mute_for","durationMs":10000,"overlayAssetKey":"mic_off","deliveryCount":2,"assetHashValid":true,"muteVerified":true,"restoreVerified":false,"overlayDisplayed":true,"overlayHidden":true,"ackSent":false,"recoveryJournalEmpty":false,"expectedOutcome":"blocked"}""";
        var blocked = CollectorReplayAcceptance.Evaluate(CollectorReplayAcceptance.Parse(restoreFailure));
        Equal("blocked", blocked.State, "restore failure replay is fail-closed");

        var builtIn = CollectorReplayAcceptance.EvaluateBuiltInCandidate();
        Equal("pass", builtIn.Overall, "built-in tester replay candidate passes without a live event");
        True(!builtIn.LiveEventUsed, "built-in tester replay never uses a live event");
        Equal(1, builtIn.RecordedSuccessExecutions, "built-in replay deduplicates recorded redelivery");
        True(builtIn.UnknownFieldRejected, "built-in replay rejects broadened fixture fields");
        True(blocked.Failures.Contains("restore"), "restore failure remains visible");
        True(blocked.Failures.Contains("ack"), "unsafe result cannot be ACKed as success");

        Throws<InvalidDataException>(
            () => CollectorReplayAcceptance.Parse(success.Replace("}", ",\"secret\":\"x\"}")),
            "unknown replay fields are rejected");
    }

    private static void RouletteResultParserTests()
    {
        var split = RouletteResultParser.Split("A 단컷 & A 네컷 & A 세컷");
        Equal(3, split.Count, "roulette ampersand result is split into independent records");
        Equal("A 단컷", split[0], "roulette split preserves first result");
        Equal("A 네컷", split[1], "roulette split preserves middle result");
        Equal("A 세컷", split[2], "roulette split preserves last result");
        Equal(1, RouletteResultParser.Split("A 움짤").Count, "single roulette result stays single");
        Equal(2, RouletteResultParser.Split(" A 단컷 & & A 세컷 ").Count, "empty roulette segments are ignored");

        var bundledReward = RouletteResultParser.ParseSpins(new[] { "A 단컷 & A 움짤" });
        Equal(1, bundledReward.SpinCount, "ampersand rewards remain one roulette spin");
        Equal(2, bundledReward.Results.Count, "one roulette spin can create two independent rewards");
        Equal("A 단컷", bundledReward.Results[0], "bundled reward preserves first output");
        Equal("A 움짤", bundledReward.Results[1], "bundled reward preserves second output");
        Equal("matched", RouletteResultParser.ValidateSpinCount(1, bundledReward.SpinCount),
            "one bundled roulette spin passes one-spin validation");

        var twoSpins = RouletteResultParser.ParseSpins(new[] { "A 단컷", "A 움짤" });
        Equal(2, twoSpins.SpinCount, "two raw roulette entries remain two spins");
        Equal(2, twoSpins.Results.Count, "two raw roulette entries preserve both rewards");
        Equal("over", RouletteResultParser.ValidateSpinCount(1, twoSpins.SpinCount),
            "two raw roulette entries still fail one-spin validation as over");

        var blankSpin = RouletteResultParser.ParseSpins(new string?[] { " ", null, "A 단컷" });
        Equal(1, blankSpin.SpinCount, "blank raw entries do not inflate roulette spins");
        Equal(1, blankSpin.Results.Count, "blank raw entries do not create rewards");
    }

    private static void AgentUpdateTests(string root)
    {
        True(AgentUpdateTrust.VerifyPinnedKeySelfTest(),
            "legacy, primary, and recovery updater keys verify fixed offline golden signatures");
        var trustFixtureTime = new DateTimeOffset(2026, 8, 23, 0, 16, 0, TimeSpan.Zero);
        var primaryCatalog = ReadEmbeddedBytes("HurogiCollector.AgentStoreTests.update-primary-v07042.json");
        var recoveryCatalog = ReadEmbeddedBytes("HurogiCollector.AgentStoreTests.update-recovery-v07042.json");
        var primaryVerified = AgentUpdateVerifier.VerifyCatalogWithPinnedTrust(primaryCatalog, trustFixtureTime);
        var recoveryVerified = AgentUpdateVerifier.VerifyCatalogWithPinnedTrust(recoveryCatalog, trustFixtureTime);
        Equal("0.7.0.42", primaryVerified.Payload.Version,
            "primary update key verifies a sealed catalog through the runtime trust resolver");
        Equal("0.7.0.42", recoveryVerified.Payload.Version,
            "offline recovery key independently verifies a sealed catalog through the runtime trust resolver");
        var unknownKeyCatalog = Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(primaryCatalog).Replace(
                AgentUpdateTrust.PrimaryKeyId,
                "rsa3072-0000000000000000",
                StringComparison.Ordinal));
        ThrowsAny(
            () => AgentUpdateVerifier.VerifyCatalogWithPinnedTrust(unknownKeyCatalog, trustFixtureTime),
            "an unpinned update key is rejected before catalog acceptance");
        Equal(0, AgentUpdatePreflight.Run("0.7.0.31", "0.7.0.31"),
            "update preflight requires the pinned-key golden self-test");
        Equal(3, AgentUpdatePreflight.Run("0.7.0.31", "0.7.0.32"),
            "update preflight rejects an executable whose embedded version differs from the signed release");
        Equal(10, AgentUpdateRunner.UpdateInstalledExitCode,
            "a committed update has one stable process handoff exit code");
        True(AgentUpdateRunner.IsBlockedCandidate("0.7.0.31", "0.7.0.31"),
            "manual rollback blocks the exact rejected update version");
        False(AgentUpdateRunner.IsBlockedCandidate("0.7.0.32", "0.7.0.31"),
            "manual rollback still allows a higher update version");
        Equal<string?>(null,
            AgentUpdateRunner.BlockedVersionAfterSuccessfulInstall("0.7.0.32", "0.7.0.31"),
            "a successfully installed higher version clears the older rollback block");
        Equal("0.7.0.31",
            AgentUpdateRunner.BlockedVersionAfterSuccessfulInstall("0.7.0.30", "0.7.0.31"),
            "an older different install cannot clear the rejected-version block");

        using var signingKey = RSA.Create(3072);
        var now = DateTimeOffset.UtcNow;
        var packageBytes = BuildUpdateFixtureZip("0.7.0.31", out var innerManifestSha256, out var appSha256);
        var packagePath = Path.Combine(root, "agent-update-fixture.zip");
        File.WriteAllBytes(packagePath, packageBytes);
        var packageSha256 = Convert.ToHexString(SHA256.HashData(packageBytes)).ToLowerInvariant();

        var payload = new
        {
            schemaVersion = 1,
            product = "byeollog-collector",
            channel = "stable",
            platform = "win-x64",
            releaseSequence = 7031,
            version = "0.7.0.31",
            displayVersion = "0.7.0 공개판 29",
            publishedAtUtc = now.AddMinutes(-1),
            expiresAtUtc = now.AddDays(30),
            minimumUpdaterProtocol = 1,
            mandatory = false,
            package = new
            {
                url = "https://byeollog.com/agent-updates/releases/0.7.0.31/fixture.zip",
                byteSize = packageBytes.LongLength,
                sha256 = packageSha256,
                innerManifestSha256
            },
            summary = "fixture"
        };
        var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        var signature = signingKey.SignData(payloadBytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        var envelope = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            payload = Convert.ToBase64String(payloadBytes),
            signature = new
            {
                algorithm = AgentUpdateTrust.SignatureAlgorithm,
                keyId = AgentUpdateTrust.KeyId,
                value = Convert.ToBase64String(signature)
            }
        });

        var verified = AgentUpdateVerifier.VerifyCatalog(envelope, signingKey, now);
        Equal("0.7.0.31", verified.Payload.Version, "signed update catalog preserves the release version");
        True(AgentUpdateVerifier.IsNewer("0.7.0.31", "0.7.0.30"), "newer four-part Agent version is selected");
        False(AgentUpdateVerifier.IsNewer("0.7.0.30", "0.7.0.30"), "same Agent version is never reinstalled");

        var altered = envelope.ToArray();
        altered[^12] ^= 1;
        ThrowsAny(
            () => AgentUpdateVerifier.VerifyCatalog(altered, signingKey, now),
            "altered update envelope is rejected");

        var installRoot = Path.Combine(root, "managed-install");
        Directory.CreateDirectory(Path.Combine(installRoot, "versions", "0.7.0.30"));
        var olderVersionSentinel = Path.Combine(installRoot, "versions", "0.7.0.20", "legacy-version.keep");
        Directory.CreateDirectory(Path.GetDirectoryName(olderVersionSentinel)!);
        File.WriteAllText(olderVersionSentinel, "preserve");
        var adjacentLegacyRoot = Path.Combine(root, "ByeollogVNextCollector");
        Directory.CreateDirectory(adjacentLegacyRoot);
        File.WriteAllText(Path.Combine(adjacentLegacyRoot, "legacy-install.keep"), "preserve");
        foreach (var name in ProtocolV1FixtureRootFiles)
            File.WriteAllBytes(Path.Combine(installRoot, name), FrozenRootFixtureBytes(name));
        File.WriteAllText(
            Path.Combine(installRoot, "current.json"),
            "{\"schemaVersion\":1,\"version\":\"0.7.0.30\"}");
        var installed = AgentUpdatePackageInstaller.InstallVerifiedPackage(
            packagePath,
            verified.Payload,
            installRoot,
            "0.7.0.30",
            runPreflight: false);
        Equal("0.7.0.31", installed, "verified update is installed into a new immutable version folder");
        True(File.Exists(Path.Combine(installRoot, "versions", "0.7.0.31", "byeollog.exe")),
            "updated app exists in the new version folder");
        Equal(appSha256,
            Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(installRoot, "versions", "0.7.0.31", "byeollog.exe")))).ToLowerInvariant(),
            "installed update app hash matches the signed package manifest");
        using var currentPointer = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(installRoot, "current.json")));
        Equal("0.7.0.31", currentPointer.RootElement.GetProperty("version").GetString(),
            "current pointer switches only after the new version is complete");
        using var previousPointer = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(installRoot, "previous.json")));
        Equal("0.7.0.30", previousPointer.RootElement.GetProperty("version").GetString(),
            "previous pointer preserves rollback to the prior version");
        True(File.Exists(olderVersionSentinel),
            "an older immutable version folder is preserved during pointer update");
        True(File.Exists(Path.Combine(adjacentLegacyRoot, "legacy-install.keep")),
            "an adjacent legacy installation root is never modified by the managed updater");
    }

    private static async Task AgentUpdateRedirectTestsAsync(string root)
    {
        const string version = "0.7.0.85";
        const string fileName = "byeollog_agent_v07085_VOICE_ANONYMIZER_REDIRECT_FIX_WIN_X64.zip";
        var initial = new Uri($"https://byeollog.com/agent-updates/releases/{version}/{fileName}");
        var github = new Uri(
            $"https://github.com/byellogDev/byeollog-releases/releases/download/agent-v{version}/{fileName}");
        var releaseAsset = new Uri(
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset.zip?sig=one");
        var bytes = Encoding.UTF8.GetBytes("redirected-signed-package-fixture");
        var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

        async Task DownloadAsync(ScriptedUpdateHandler handler, string destination)
        {
            using var client = new HttpClient(handler);
            await AgentUpdateRunner.DownloadPackageAsync(
                client,
                initial,
                version,
                destination,
                bytes.LongLength,
                sha256,
                CancellationToken.None);
        }

        var githubDestination = Path.Combine(root, "redirect-github.zip");
        var githubHandler = new ScriptedUpdateHandler(
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, github),
            _ => UpdateRedirect(HttpStatusCode.Redirect, releaseAsset),
            _ => UpdateOk(bytes));
        await DownloadAsync(githubHandler, githubDestination);
        Equal(3, githubHandler.Requests.Count,
            "the package downloader follows exactly the approved GitHub and release-assets hops");
        Equal(initial.AbsoluteUri, githubHandler.Requests[0].AbsoluteUri,
            "the first package request preserves the exact signed byeollog.com URL");
        Equal(github.AbsoluteUri, githubHandler.Requests[1].AbsoluteUri,
            "the first redirect uses the exact release tag and package filename");
        Equal(releaseAsset.AbsoluteUri, githubHandler.Requests[2].AbsoluteUri,
            "the second redirect reaches only the GitHub release-assets host");
        True(CryptographicOperations.FixedTimeEquals(bytes, File.ReadAllBytes(githubDestination)),
            "an approved two-hop package still passes length and SHA-256 verification");

        var directDestination = Path.Combine(root, "redirect-direct-assets.zip");
        var directHandler = new ScriptedUpdateHandler(
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, releaseAsset),
            _ => UpdateOk(bytes));
        await DownloadAsync(directHandler, directDestination);
        Equal(2, directHandler.Requests.Count,
            "a Vercel external rewrite may redirect directly to release-assets");

        var crossHostDestination = Path.Combine(root, "redirect-cross-host.zip");
        var crossHostHandler = new ScriptedUpdateHandler(
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, new Uri("https://downloads.example/agent.zip")));
        await ThrowsAsync<InvalidDataException>(
            () => DownloadAsync(crossHostHandler, crossHostDestination),
            "a package redirect to an unapproved host is rejected before a second request");
        Equal(1, crossHostHandler.Requests.Count,
            "a rejected cross-host redirect is never requested");
        False(File.Exists(crossHostDestination),
            "a rejected cross-host redirect creates no package file");

        var context = AgentUpdatePackageRedirectPolicy.Create(initial, version);
        Throws<InvalidDataException>(
            () => AgentUpdatePackageRedirectPolicy.Create(
                new Uri($"https://byeollog.com/agent-updates/releases/0.7.0.84/{fileName}"),
                version),
            "the signed package URL path must contain the exact payload version");
        foreach (var invalidTarget in new[]
        {
            new Uri("http://release-assets.githubusercontent.com/asset.zip"),
            new Uri("https://user@release-assets.githubusercontent.com/asset.zip"),
            new Uri("https://release-assets.githubusercontent.com:444/asset.zip"),
            new Uri("https://release-assets.githubusercontent.com/asset.zip#fragment"),
            new Uri($"https://github.com/byellogDev/byeollog-releases/releases/download/agent-v{version}/wrong.zip")
        })
        {
            Throws<InvalidDataException>(
                () => AgentUpdatePackageRedirectPolicy.ResolveAndValidate(
                    context,
                    initial,
                    invalidTarget,
                    redirectNumber: 1),
                "redirect endpoints require HTTPS, the default port, no credentials/fragment, and the exact GitHub path");
        }
        Throws<InvalidDataException>(
            () => AgentUpdatePackageRedirectPolicy.ResolveAndValidate(
                context,
                github,
                github,
                redirectNumber: 2),
            "the second redirect can target only release-assets.githubusercontent.com");

        var loopDestination = Path.Combine(root, "redirect-loop.zip");
        var loopHandler = new ScriptedUpdateHandler(
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, releaseAsset),
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, releaseAsset));
        await ThrowsAsync<InvalidDataException>(
            () => DownloadAsync(loopHandler, loopDestination),
            "a repeated release-assets URL is rejected as a redirect loop");
        Equal(2, loopHandler.Requests.Count,
            "the redirect loop is rejected before repeating its request");
        False(File.Exists(loopDestination),
            "a redirect loop creates no package file");

        var secondAsset = new Uri(
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-2.zip?sig=two");
        var excessDestination = Path.Combine(root, "redirect-excess.zip");
        var excessHandler = new ScriptedUpdateHandler(
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, github),
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, releaseAsset),
            _ => UpdateRedirect(HttpStatusCode.TemporaryRedirect, secondAsset));
        await ThrowsAsync<InvalidDataException>(
            () => DownloadAsync(excessHandler, excessDestination),
            "a third redirect is rejected even when its host is otherwise approved");
        Equal(3, excessHandler.Requests.Count,
            "the downloader never issues a request beyond its two-redirect budget");
        False(File.Exists(excessDestination),
            "an excessive redirect chain creates no package file");
    }

    private static HttpResponseMessage UpdateRedirect(HttpStatusCode statusCode, Uri location)
    {
        var response = new HttpResponseMessage(statusCode);
        response.Headers.Location = location;
        return response;
    }

    private static HttpResponseMessage UpdateOk(byte[] bytes)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentLength = bytes.LongLength;
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    private static byte[] ReadEmbeddedBytes(string resourceName)
    {
        using var stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Missing embedded fixture: {resourceName}");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private static byte[] BuildUpdateFixtureZip(
        string version,
        out string innerManifestSha256,
        out string appSha256)
    {
        var appBytes = Encoding.UTF8.GetBytes("signed-update-fixture-app");
        appSha256 = Convert.ToHexString(SHA256.HashData(appBytes)).ToLowerInvariant();
        var documentationBytes = Encoding.UTF8.GetBytes("fixture notes");
        var documentationSha256 = Convert.ToHexString(SHA256.HashData(documentationBytes)).ToLowerInvariant();
        var frozenRootFiles = ProtocolV1FixtureRootFiles.Select(name =>
        {
            var bytes = FrozenRootFixtureBytes(name);
            return (Name: name, Bytes: bytes, Sha256: Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        }).ToArray();
        var manifestFiles = new List<object>
        {
            new { path = "byeollog.exe", role = "app", byteSize = appBytes.LongLength, sha256 = appSha256 },
            new { path = "RELEASE_FIXTURE.txt", role = "documentation", byteSize = documentationBytes.LongLength, sha256 = documentationSha256 }
        };
        manifestFiles.AddRange(frozenRootFiles.Select(file => (object)new
        {
            path = file.Name,
            role = "install_root",
            byteSize = file.Bytes.LongLength,
            sha256 = file.Sha256
        }));
        var manifest = new
        {
            schemaVersion = 2,
            product = "byeollog-collector",
            version,
            platform = "win-x64",
            packageLayout = "flat_v1",
            generatedAtUtc = DateTimeOffset.UtcNow,
            fileCount = manifestFiles.Count,
            totalByteSize = appBytes.LongLength + documentationBytes.LongLength + frozenRootFiles.Sum(static file => file.Bytes.LongLength),
            authenticity = new
            {
                mode = "trusted_channel_internal",
                scope = "package_integrity_only",
                signerThumbprint = (string?)null
            },
            files = manifestFiles
        };
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(manifest);
        innerManifestSha256 = Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant();
        var checksumText = new StringBuilder()
            .Append(appSha256).Append("  byeollog.exe\n")
            .Append(documentationSha256).Append("  RELEASE_FIXTURE.txt\n");
        foreach (var file in frozenRootFiles)
            checksumText.Append(file.Sha256).Append("  ").Append(file.Name).Append('\n');
        checksumText.Append(innerManifestSha256).Append("  release-manifest.json\n");
        var checksumBytes = Encoding.ASCII.GetBytes(checksumText.ToString());

        using var output = new MemoryStream();
        using (var archive = new System.IO.Compression.ZipArchive(output, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteZipEntry(archive, "byeollog.exe", appBytes);
            WriteZipEntry(archive, "RELEASE_FIXTURE.txt", documentationBytes);
            foreach (var file in frozenRootFiles)
                WriteZipEntry(archive, file.Name, file.Bytes);
            WriteZipEntry(archive, "release-manifest.json", manifestBytes);
            WriteZipEntry(archive, "SHA256SUMS.txt", checksumBytes);
        }
        return output.ToArray();
    }

    private static byte[] FrozenRootFixtureBytes(string name) =>
        Encoding.UTF8.GetBytes("protocol-v1-frozen-root:" + name);

    private static void WriteZipEntry(System.IO.Compression.ZipArchive archive, string name, byte[] bytes)
    {
        var entry = archive.CreateEntry(name, System.IO.Compression.CompressionLevel.Optimal);
        using var stream = entry.Open();
        stream.Write(bytes);
    }

    private static void AgentCapabilityTests()
    {
        var supported = VNextAgentCapabilities.ForWindowsAgent();
        Equal(10, supported.Length, "fresh Windows Agent reports only server-routable capabilities");
        True(supported.Contains("obs.mute_for", StringComparer.Ordinal),
            "OBS timed mute capability is reported before OBS settings are configured");
        True(supported.Contains("obs.voice_anonymize_for", StringComparer.Ordinal),
            "OBS voice anonymizer capability is reported before its local filter is configured");
        True(supported.Contains("obs.voice_anonymize_for_v2", StringComparer.Ordinal),
            "OBS pitch preset capability is isolated from legacy voice jobs");
        False(supported.Contains("local.log", StringComparer.Ordinal),
            "local diagnostics are not sent to the public Agent runtime");
        False(supported.Contains("obs.set_input_mute", StringComparer.Ordinal),
            "legacy OBS action is not sent to the public Agent runtime");
        True(supported.Contains("windows.mic_mute_for", StringComparer.Ordinal),
            "Windows timed mute is sent after the public runtime supports it");
        True(supported.Contains("raffle.overlay", StringComparer.Ordinal),
            "raffle animation is sent after the public runtime supports it");
        True(supported.Contains("flashbang.overlay", StringComparer.Ordinal),
            "flashbang animation and Browser Source sound are publicly routable");
        True(supported.Contains("obs.screen_flip_for", StringComparer.Ordinal),
            "screen flip is routed only after OBS scene recovery support is packaged");
        True(supported.Contains("obs.screen_shake_for", StringComparer.Ordinal),
            "screen shake is routed only after OBS scene recovery support is packaged");
        True(supported.Contains("water_splash.overlay", StringComparer.Ordinal),
            "water splash overlay and sound are publicly routable");
        True(supported.Contains("fireworks.overlay", StringComparer.Ordinal),
            "fireworks overlay and sound are publicly routable");

        supported[0] = "mutated";
        False(VNextAgentCapabilities.ForWindowsAgent().Contains("mutated", StringComparer.Ordinal),
            "callers cannot mutate the canonical capability set");
    }

    private static void WebViewTrustPolicyTests()
    {
        True(
            WebViewTrustPolicy.IsTrustedUiMessageSource("https://byeollog.local/byeollog_ui.html?secret=hidden"),
            "local UI messages accept only the mapped HTTPS origin");
        False(
            WebViewTrustPolicy.IsTrustedUiMessageSource("https://evil.byeollog.local/"),
            "local UI messages reject lookalike subdomains");
        True(
            WebViewTrustPolicy.IsTrustedWeflabMessageSource("https://app.weflab.com/path?token=hidden"),
            "collector messages accept a Weflab subdomain");
        False(
            WebViewTrustPolicy.IsTrustedWeflabMessageSource("https://weflab.com.evil.example/"),
            "collector messages reject suffix lookalikes");

        True(
            WebViewTrustPolicy.IsAllowedUiNavigation("https://byeollog.local/byeollog_ui.html", out _),
            "local UI navigation remains on the mapped host");
        False(
            WebViewTrustPolicy.IsAllowedUiNavigation("https://weflab.com/", out _),
            "local UI cannot navigate to remote content");
        True(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/agent_automation.html?theme=dark#top",
                out var automationReason),
            "automation navigation accepts its exact HTTPS document with compatible query and fragment");
        Equal("automation_ui", automationReason, "exact automation document reports its trusted reason");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/byeollog_ui.html",
                out var automationSiblingReason),
            "automation navigation rejects a sibling mapped UI document");
        Equal("path", automationSiblingReason, "automation sibling rejection identifies the path boundary");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/",
                out var automationRootReason),
            "automation navigation rejects the mapped host root");
        Equal("path", automationRootReason, "automation root rejection identifies the path boundary");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/nested/agent_automation.html",
                out _),
            "automation navigation rejects a nested lookalike path");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/agent_automation.html/",
                out _),
            "automation navigation rejects a trailing-slash path extension");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local/Agent_Automation.html",
                out _),
            "automation path matching remains ordinal and case exact");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation(
                "https://byeollog-agent.local.evil.example/agent_automation.html",
                out var automationHostReason),
            "automation navigation rejects a host suffix lookalike");
        Equal("host", automationHostReason, "automation lookalike rejection identifies the host boundary");
        False(
            WebViewTrustPolicy.IsAllowedAutomationNavigation("about:blank", out var automationBlankReason),
            "automation top-level navigation rejects about:blank after controller initialization");
        Equal("scheme", automationBlankReason, "automation blank navigation fails at the HTTPS boundary");
        True(
            WebViewTrustPolicy.IsAllowedWeflabNavigation("https://accounts.google.com/o/oauth2/auth?code=hidden", out _),
            "allowlisted OAuth navigation remains compatible");
        False(
            WebViewTrustPolicy.IsAllowedWeflabNavigation("https://accounts.google.com.evil.example/", out _),
            "OAuth lookalike navigation is blocked");
        False(
            WebViewTrustPolicy.IsAllowedWeflabNavigation("https://user:password@accounts.google.com/oauth", out _),
            "userinfo-bearing navigation is blocked");
        False(
            WebViewTrustPolicy.IsAllowedWeflabNavigation("https://accounts.google.com:444/oauth", out _),
            "non-standard HTTPS ports are blocked");

        Equal(
            "https://accounts.google.com",
            WebViewTrustPolicy.SafeOriginForLog("https://user:password@accounts.google.com/oauth?code=very-secret#fragment"),
            "safe URL logging removes credentials, path, query, and fragment");
        Equal(
            "javascript:[redacted]",
            WebViewTrustPolicy.SafeOriginForLog("javascript:alert('secret')"),
            "non-web schemes never reach logs verbatim");

        True(
            WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                "https://byeollog.com/",
                "/dashboard?handoff=opaque",
                out var dashboardUri,
                out _)
            && dashboardUri.AbsoluteUri == "https://byeollog.com/dashboard?handoff=opaque",
            "external dashboard navigation stays on the configured HTTPS origin");
        False(
            WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                "https://byeollog.com/",
                "https://evil.example/dashboard",
                out _,
                out _),
            "cross-origin dashboard navigation is rejected");
        False(
            WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                "https://byeollog.com/",
                "file:///C:/Windows/System32/calc.exe",
                out _,
                out _),
            "non-HTTP external navigation is rejected");
        True(
            WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                "http://127.0.0.1:3000/",
                "/signup",
                out _,
                out _),
            "loopback HTTP remains available for local development");
        False(
            WebViewTrustPolicy.TryResolveSameOriginExternalUri(
                "http://example.com/",
                "/signup",
                out _,
                out _),
            "remote cleartext HTTP is rejected");

        True(
            WebViewTrustPolicy.TryParseUiMessage(
                "{\"action\":\"theme\",\"payload\":{\"theme\":\"dark\"}}",
                out _,
                out var uiAction,
                out _),
            "known UI action with an object payload is accepted");
        Equal("theme", uiAction, "validated UI action is returned");
        False(
            WebViewTrustPolicy.TryParseUiMessage(
                "{\"action\":\"executeScript\",\"payload\":{}}",
                out _,
                out _,
                out var blockedUiReason),
            "unknown privileged UI actions fail closed");
        Equal("action_blocked", blockedUiReason, "blocked UI action has a non-sensitive reason code");
        False(
            WebViewTrustPolicy.TryParseUiMessage(
                new string('x', WebViewTrustPolicy.MaxUiMessageChars + 1),
                out _,
                out _,
                out var largeUiReason),
            "oversized UI messages are rejected before JSON parsing");
        Equal("too_large", largeUiReason, "oversized UI rejection is deterministic");

        var probe = JsonSerializer.Serialize(
            "{\"kind\":\"probe\",\"logged\":true,\"idx\":\"private-id\",\"hasLoginData\":true,\"hasJquery\":true,\"href\":\"https://weflab.com/path?token=hidden\"}");
        True(
            WebViewTrustPolicy.TryParseWeflabMessage(probe, out _, out var kind, out _),
            "legacy double-encoded Weflab messages remain compatible");
        Equal("probe", kind, "validated Weflab kind is returned");
        False(
            WebViewTrustPolicy.TryParseWeflabMessage(
                "{\"kind\":\"eval\",\"payload\":{}}",
                out _,
                out _,
                out var blockedKindReason),
            "unknown Weflab message kinds fail closed");
        Equal("kind_blocked", blockedKindReason, "blocked Weflab kind has a non-sensitive reason code");

        foreach (var action in new[]
        {
            "renameAgentDevice",
            "revokeAgentDevice",
            "previewOverlayAsset",
            "testVoiceAnonymizerFilter",
            "ensureVoiceAnonymizerFilters"
        })
        {
            True(
                WebViewTrustPolicy.TryParseAutomationMessage(
                    JsonSerializer.Serialize(new { action, payload = new { deviceId = "11111111-1111-4111-8111-111111111111" } }),
                    out _,
                    out var parsedAction,
                    out _),
                $"{action} automation action accepts an object payload");
            Equal(action, parsedAction, $"{action} automation action is returned exactly");
            False(
                WebViewTrustPolicy.TryParseAutomationMessage(
                    JsonSerializer.Serialize(new { action }),
                    out _,
                    out _,
                    out var payloadReason),
                $"{action} automation action requires a payload");
            Equal("payload_required", payloadReason, $"{action} missing payload fails closed");
        }
        foreach (var action in new[]
        {
            "syncOverlayAssets",
            "copyOverlayUrl"
        })
        {
            True(
                WebViewTrustPolicy.TryParseAutomationMessage(
                    JsonSerializer.Serialize(new { action, payload = new { } }),
                    out _,
                    out var parsedAction,
                    out _),
                $"{action} automation action is explicitly allowlisted");
            Equal(action, parsedAction, $"{action} automation action is returned exactly");
            False(
                WebViewTrustPolicy.TryParseAutomationMessage(
                    JsonSerializer.Serialize(new { action, payload = new { unexpected = "value" } }),
                    out _,
                    out _,
                    out var payloadReason),
                $"{action} rejects unused attacker-controlled payload fields");
            Equal("payload_shape", payloadReason, $"{action} unexpected payload fails closed");
        }
        True(
            WebViewTrustPolicy.TryParseAutomationMessage(
                JsonSerializer.Serialize(new
                {
                    action = "previewVoiceAnonymizer",
                    payload = new { preset = "anonymous_high" }
                }),
                out _,
                out var previewVoiceAction,
                out _),
            "voice preview accepts a preset-bearing object payload");
        Equal("previewVoiceAnonymizer", previewVoiceAction,
            "voice preview action is returned exactly");
        False(
            WebViewTrustPolicy.TryParseAutomationMessage(
                "{\"action\":\"previewVoiceAnonymizer\"}",
                out _,
                out _,
                out var previewVoicePayloadReason),
            "voice preview requires an explicit preset payload");
        Equal("payload_required", previewVoicePayloadReason,
            "missing voice preview payload fails closed");
        False(
            WebViewTrustPolicy.TryParseAutomationMessage(
                "{\"action\":\"publishOverlayAsset\",\"payload\":{}}",
                out _,
                out _,
                out var blockedAutomationReason),
            "operator-only overlay publishing is not exposed to the Agent WebView");
        Equal("action_blocked", blockedAutomationReason, "unknown automation mutation fails closed");
    }

    private static void CollectorStateLifecycleTests(string root)
    {
        var stateRoot = Path.Combine(root, "state-lifecycle");
        Directory.CreateDirectory(stateRoot);
        var configPath = Path.Combine(stateRoot, "collector_config.json");
        const string firstConfig = "{\"ServerUrl\":\"https://byeollog.com/api/collector\",\"CollectorToken\":\"dpapi:first\"}";
        const string secondConfig = "{\"ServerUrl\":\"https://byeollog.com/api/collector\",\"CollectorToken\":\"dpapi:second\"}";

        CollectorStateLifecycle.AtomicWriteText(configPath, firstConfig);
        CollectorStateLifecycle.AtomicWriteText(configPath, secondConfig);
        True(File.Exists(configPath + ".bak"), "atomic state writes retain one previous copy");
        Equal(firstConfig, File.ReadAllText(configPath + ".bak"), "state backup contains the prior complete value");

        var prepared = CollectorStateLifecycle.Prepare(stateRoot, "0.5.7.0-test");
        True(prepared.SnapshotCreated, "first start of a version creates a state snapshot once");
        True(File.Exists(Path.Combine(prepared.SnapshotPath, "snapshot-manifest.json")), "state snapshot has a hash manifest");
        True(File.Exists(Path.Combine(prepared.SnapshotPath, "collector_config.json")), "state snapshot includes protected configuration");
        Equal(CollectorStateLifecycle.CurrentSchemaVersion, prepared.SchemaVersion, "state schema is explicit");

        var preparedAgain = CollectorStateLifecycle.Prepare(stateRoot, "0.5.7.0-test");
        False(preparedAgain.SnapshotCreated, "same version does not overwrite its pre-start snapshot");

        File.WriteAllText(configPath, "{broken-json", Encoding.UTF8);
        var recovered = CollectorStateLifecycle.Prepare(stateRoot, "0.5.7.0-test");
        Equal(firstConfig, File.ReadAllText(configPath), "corrupt state is restored from the last valid sidecar");
        True(recovered.RestoredFiles.Contains("collector_config.json"), "automatic recovery is reported without secret values");
        Equal(1, Directory.EnumerateFiles(stateRoot, "collector_config.json.corrupt-*").Count(), "corrupt original is preserved for support");

        CollectorStateLifecycle.AtomicWriteText(
            Path.Combine(stateRoot, "state-schema.json"),
            "{\"schemaVersion\":99,\"appVersion\":\"future\"}");
        Throws<InvalidOperationException>(
            () => CollectorStateLifecycle.Prepare(stateRoot, "0.5.6.6-downgrade"),
            "older binaries fail closed on a newer state schema");
    }

    private static void AcceptanceEvaluatorTests()
    {
        const string assetId = "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc";
        const string sha256 = "e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b";
        using var document = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"initialMuted\":false,\"changed\":true,\"mutedVerified\":true,\"restoredVerified\":true,\"overlayAssetKey\":\"mic_off\",\"overlayAssetId\":\"" + assetId + "\",\"overlayAssetVersion\":1,\"overlayContentSha256\":\"" + sha256 + "\",\"overlayDisplayed\":true}");
        var now = DateTimeOffset.UtcNow;
        var evidence = new VNextAgentExecutionEvidence(
            "obs.mute_for",
            "succeeded",
            1,
            now,
            now.AddSeconds(10),
            assetId,
            1,
            sha256,
            true,
            document.RootElement.Clone());
        var clean = new CollectorAcceptancePreflightSnapshot("pass", 0, 0, 1, false);
        var overlayBefore = new CollectorAcceptanceOverlaySnapshot(10, false, 20, 0, 1);
        var overlayAfter = new CollectorAcceptanceOverlaySnapshot(12, false, 140, 100, 1);

        var passed = CollectorAcceptanceEvaluator.Evaluate(
            "0.5.7.0-dev-replay-beta-candidate",
            now,
            clean,
            clean,
            evidence,
            overlayBefore,
            overlayAfter,
            CollectorAcceptanceEvaluator.ConfirmedBoth);
        Equal("pass", passed.OverallState, "complete telemetry and both visual confirmations pass acceptance");
        True(passed.Checks.All(check => check.State == "pass"), "acceptance pass has no hidden attention state");

        var notObserved = CollectorAcceptanceEvaluator.Evaluate(
            "0.5.7.0-dev-replay-beta-candidate",
            now,
            clean,
            clean,
            evidence,
            overlayBefore,
            overlayAfter,
            CollectorAcceptanceEvaluator.NotObserved);
        Equal("attention", notObserved.OverallState, "missing visual observation cannot become a full pass");

        var wrongRevision = evidence with { ExpectedOverlayContentSha256 = new string('f', 64) };
        var blocked = CollectorAcceptanceEvaluator.Evaluate(
            "0.5.7.0-dev-replay-beta-candidate",
            now,
            clean,
            clean,
            wrongRevision,
            overlayBefore,
            overlayAfter,
            CollectorAcceptanceEvaluator.ConfirmedBoth);
        Equal("blocked", blocked.OverallState, "an overlay revision mismatch fails closed");
    }

    private static async Task OverlayAssetCacheTestsAsync(string root)
    {
        var cacheRoot = Path.Combine(root, "overlay-cache");
        var managedBytes = Encoding.UTF8.GetBytes(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"180\"><rect width=\"320\" height=\"180\" fill=\"#17243a\"/></svg>");
        var managed = ManagedDescriptor(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "managed_notice",
            1,
            managedBytes,
            required: true);

        var legacyAssetKey = "microphone_off";
        var legacyDeliveryMode = "builtin";
        True(
            OverlayAssetCatalogCompatibility.TryNormalizeExactBuiltIn(
                OverlayAssetCache.BuiltInAssetId,
                1,
                "image/svg+xml",
                OverlayAssetCache.BuiltInContentSha256,
                1_926,
                1_200,
                360,
                ref legacyAssetKey,
                ref legacyDeliveryMode),
            "the exact public catalog built-in descriptor accepts legacy labels");
        Equal(OverlayAssetCache.MicrophoneOffAssetKey, legacyAssetKey,
            "the legacy public catalog key is normalized to the embedded key");
        Equal("agent_builtin", legacyDeliveryMode,
            "the legacy public catalog delivery mode is normalized to the embedded mode");

        var centerAssetKey = OverlayAssetCache.MicrophoneOffCenterAssetKey;
        var centerDeliveryMode = "builtin";
        True(
            OverlayAssetCatalogCompatibility.TryNormalizeExactBuiltIn(
                OverlayAssetCache.MicrophoneOffCenterAssetId,
                1,
                "image/png",
                OverlayAssetCache.MicrophoneOffIconContentSha256,
                335_254,
                1_254,
                1_254,
                ref centerAssetKey,
                ref centerDeliveryMode),
            "the exact center-position icon catalog descriptor is accepted");
        Equal(OverlayAssetCache.MicrophoneOffCenterAssetKey, centerAssetKey,
            "the center-position icon keeps its placement key");
        Equal("agent_builtin", centerDeliveryMode,
            "the center-position icon uses embedded delivery");

        var forgedAssetKey = "microphone_off";
        var forgedDeliveryMode = "builtin";
        False(
            OverlayAssetCatalogCompatibility.TryNormalizeExactBuiltIn(
                OverlayAssetCache.BuiltInAssetId,
                1,
                "image/svg+xml",
                new string('f', 64),
                1_926,
                1_200,
                360,
                ref forgedAssetKey,
                ref forgedDeliveryMode),
            "legacy labels cannot alias bytes with a different SHA-256");

        VNextOverlayAssetDescriptor builtInCatalog;
        {
            var probe = new OverlayAssetCache(Path.Combine(root, "overlay-probe"));
            True(
                probe.TryResolve(OverlayAssetCache.MicrophoneOffAssetKey, null, out var builtIn),
                "embedded overlay image resolves before the network is available");
            Equal(
                "e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b",
                builtIn.ContentSha256,
                "embedded mic-off image matches the catalog digest");
            Equal(1_926, builtIn.ByteSize, "embedded mic-off image matches the catalog byte size");
            Equal((1_200, 360), OverlayAssetValidator.Inspect(probe.Read(builtIn).Bytes, builtIn.MimeType),
                "embedded mic-off dimensions are verified");
            True(
                probe.TryResolve(OverlayAssetCache.MicrophoneOffCenterAssetKey, null, out var centerBuiltIn),
                "the selected simple center icon resolves before the network is available");
            Equal(OverlayAssetCache.MicrophoneOffIconContentSha256, centerBuiltIn.ContentSha256,
                "the selected simple icon matches its immutable catalog digest");
            Equal((1_254, 1_254), OverlayAssetValidator.Inspect(probe.Read(centerBuiltIn).Bytes, centerBuiltIn.MimeType),
                "the selected simple icon remains square");
            builtInCatalog = builtIn with
            {
                AssetId = "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc",
                Required = true
            };
        }

        var manifest = new VNextOverlayAssetManifest(
            1,
            DateTimeOffset.UtcNow,
            new[] { builtInCatalog, managed });

        {
            var wrongBuiltInId = builtInCatalog with
            {
                AssetId = "699acb26-dbac-46fc-b9dc-6cbe386a1cd6"
            };
            var wrongIdCache = new OverlayAssetCache(Path.Combine(root, "overlay-wrong-built-in-id"));
            var rejectedSync = await wrongIdCache.SyncAsync(
                new VNextOverlayAssetManifest(
                    1,
                    DateTimeOffset.UtcNow,
                    new[] { wrongBuiltInId }),
                (_, _) => throw new InvalidOperationException("a built-in image must never be downloaded"),
                CancellationToken.None);
            Equal(0, rejectedSync.Available,
                "a manifest cannot alias embedded bytes under a different built-in asset ID");
            Equal(1, rejectedSync.RequiredUnavailable,
                "a required built-in manifest entry with the wrong asset ID fails closed");
            False(wrongIdCache.RequiredReady(),
                "wrong built-in manifest ID cannot report required readiness");
            False(wrongIdCache.TryResolve(
                    OverlayAssetCache.MicrophoneOffAssetKey,
                    wrongBuiltInId,
                    out _),
                "actual-job resolution rejects a built-in descriptor with the wrong asset ID");
            False(wrongIdCache.TryResolveByAssetId(
                    wrongBuiltInId.AssetId,
                    wrongBuiltInId.ContentSha256,
                    out _),
                "preview resolution rejects a built-in descriptor with the wrong asset ID");

            using var wrongIdService = new ByeollogOverlayService(
                new CollectorStorage(),
                wrongIdCache,
                AvailableLoopbackPort());
            await ThrowsAsync<InvalidOperationException>(
                () => wrongIdService.ShowAsync(
                    OverlayAssetCache.MicrophoneOffAssetKey,
                    1_000,
                    wrongBuiltInId,
                    CancellationToken.None),
                "actual automation cannot display embedded bytes for a wrong built-in job asset ID");
            False(wrongIdService.Snapshot().Active,
                "a rejected wrong-ID job never activates the overlay");
        }

        {
            var cache = new OverlayAssetCache(cacheRoot);
            var sync = await cache.SyncAsync(
                manifest,
                (asset, _) => Task.FromResult(
                    asset.AssetId == managed.AssetId
                        ? managedBytes
                        : throw new InvalidOperationException("built-in image must not be downloaded")),
                CancellationToken.None);
            Equal(2, sync.Available, "built-in and managed overlay images are available");
            Equal(1, sync.Downloaded, "managed overlay image is downloaded once");
            Equal(1, sync.Reused, "embedded overlay image is reused");
            True(cache.RequiredReady(), "all required manifest images are ready");
            True(cache.TryResolve(managed.AssetKey, managed, out var resolved), "exact managed revision resolves");
            True(cache.TryResolveByAssetId(managed.AssetId, managed.ContentSha256, out var byId)
                && byId.ContentSha256 == managed.ContentSha256,
                "preview lookup resolves only the exact cached asset ID and revision");
            True(cache.TryResolveByAssetId(
                    builtInCatalog.AssetId,
                    builtInCatalog.ContentSha256,
                    out var builtInById)
                && builtInById.ContentSha256 == builtInCatalog.ContentSha256,
                "preview lookup resolves the exact embedded catalog asset ID");
            False(cache.TryResolveByAssetId(managed.AssetId, new string('f', 64), out _),
                "managed preview lookup rejects the right asset ID with the wrong revision SHA");
            False(cache.TryResolveByAssetId(builtInCatalog.AssetId, new string('f', 64), out _),
                "embedded preview lookup rejects the right asset ID with the wrong revision SHA");
            False(cache.TryResolveByAssetId(
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    managed.ContentSha256,
                    out _),
                "preview lookup rejects an unknown asset ID");
            True(cache.Read(resolved).Bytes.SequenceEqual(managedBytes), "managed bytes are read only after verification");
            var ready = await cache.ReadyRevisionsAsync();
            Equal(cache.Status().BuiltInCount + 1, ready.Count,
                "all packaged images and one managed exact revision are reported ready");
            True(ready.Any(item => item.AssetId == builtInCatalog.AssetId
                && item.ContentSha256 == builtInCatalog.ContentSha256), "catalog-exact built-in revision is reported");
        }

        {
            var activationRoot = Path.Combine(root, "overlay-activation-toctou");
            var activationCache = new OverlayAssetCache(activationRoot);
            Task<byte[]> DownloadExactAsync(
                VNextOverlayAssetDescriptor asset,
                CancellationToken _) => Task.FromResult(
                    asset.AssetId == managed.AssetId
                        ? managedBytes
                        : throw new InvalidOperationException("built-in image must not be downloaded"));

            var initial = await activationCache.SyncAsync(manifest, DownloadExactAsync, CancellationToken.None);
            Equal(2, initial.Available, "TOCTOU fixture starts with both exact assets available");
            var activationPath = managed.DownloadPath!.Split('/')
                .Aggregate(activationRoot, Path.Combine);
            var beforePreviewCorruption = await activationCache.ReadyRevisionsAsync();
            True(beforePreviewCorruption.Any(item => item.AssetId == managed.AssetId
                && item.ContentSha256 == managed.ContentSha256),
                "managed revision is exact-ready before preview corruption");

            await File.WriteAllTextAsync(activationPath, "corrupted after readiness");
            using var activationService = new ByeollogOverlayService(
                new CollectorStorage(),
                activationCache,
                AvailableLoopbackPort());
            await ThrowsAsync<InvalidDataException>(
                () => activationService.PreviewAsync(
                    managed.AssetKey,
                    1_000,
                    managed,
                    CancellationToken.None),
                "preview revalidates cached bytes immediately before activation");
            False(activationService.Snapshot().Active,
                "a preview with post-readiness corruption never becomes active");
            Equal(0, activationCache.Status().ManagedCount,
                "preview corruption removes the exact entry from in-memory readiness");
            False(activationCache.TryResolve(managed.AssetKey, managed, out _),
                "preview corruption cannot resolve again before a verified resync");
            var restartedAfterCorruption = new OverlayAssetCache(activationRoot);
            False(restartedAfterCorruption.RequiredReady(),
                "restart preserves the required manifest while excluding its corrupted entry");
            Equal(0, restartedAfterCorruption.Status().ManagedCount,
                "restart cannot resurrect a corrupted entry from the stale on-disk index");

            var afterPreviewRepair = await activationCache.SyncAsync(
                manifest,
                DownloadExactAsync,
                CancellationToken.None);
            Equal(1, afterPreviewRepair.Downloaded,
                "verified sync repairs an entry invalidated by preview activation");
            True((await activationCache.ReadyRevisionsAsync()).Any(item => item.AssetId == managed.AssetId),
                "the repaired exact revision is ready before actual automation corruption");
            await File.WriteAllTextAsync(activationPath, "corrupted before actual activation");
            await ThrowsAsync<InvalidDataException>(
                () => activationService.ShowAsync(
                    managed.AssetKey,
                    1_000,
                    managed,
                    CancellationToken.None),
                "actual automation revalidates cached bytes immediately before activation");
            False(activationService.Snapshot().Active,
                "actual automation does not report a corrupted overlay as active");
            Equal(0, activationCache.Status().ManagedCount,
                "actual automation corruption removes the exact readiness entry");

            var beforePinnedDisplay = await activationCache.SyncAsync(
                manifest,
                DownloadExactAsync,
                CancellationToken.None);
            Equal(1, beforePinnedDisplay.Downloaded,
                "verified sync repairs the entry for the pinned-content display test");
            var pinnedDisplay = activationService.ShowAsync(
                managed.AssetKey,
                3_000,
                managed,
                CancellationToken.None);
            await WaitUntilAsync(() => activationService.Snapshot().Active, TimeSpan.FromSeconds(2));
            await File.WriteAllTextAsync(activationPath, "corrupted after activation");
            using (var http = new HttpClient(new HttpClientHandler { UseProxy = false }))
            {
                using var wrongRevision = await http.GetAsync(
                    $"{activationService.OverlayUrl}/assets/{managed.AssetId}?revision={new string('f', 64)}");
                Equal(HttpStatusCode.NotFound, wrongRevision.StatusCode,
                    "the pinned endpoint rejects the right asset ID with a stale or forged SHA");
                var displayed = await http.GetByteArrayAsync(
                    $"{activationService.OverlayUrl}/assets/{managed.AssetId}?revision={managed.ContentSha256}");
                True(displayed.SequenceEqual(managedBytes),
                    "an active overlay serves its verified in-memory snapshot, not later-corrupted disk bytes");
            }
            await pinnedDisplay.WaitAsync(TimeSpan.FromSeconds(5));
            False(activationService.Snapshot().Active,
                "the verified pinned overlay becomes inactive after its bounded duration");
            var afterPinnedCorruption = await activationCache.ReadyRevisionsAsync();
            False(afterPinnedCorruption.Any(item => item.AssetId == managed.AssetId),
                "later disk corruption is removed from readiness after the pinned display completes");
        }

        {
            var restarted = new OverlayAssetCache(cacheRoot);
            True(restarted.RequiredReady(), "last verified manifest and files survive restart");
            True(restarted.TryResolve(managed.AssetKey, managed, out var cached), "offline restart resolves exact cached revision");
            True(restarted.Read(cached).Bytes.SequenceEqual(managedBytes), "offline restart serves verified bytes");

            var unsafeBytes = Encoding.UTF8.GetBytes(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"180\"><script>alert(1)</script></svg>");
            var next = ManagedDescriptor(
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "managed_notice",
                2,
                unsafeBytes,
                required: true);
            Throws<InvalidDataException>(
                () => OverlayAssetValidator.VerifyBytes(unsafeBytes, next),
                "unsafe SVG script content is rejected even when its digest matches");

            var failed = await restarted.SyncAsync(
                new VNextOverlayAssetManifest(1, DateTimeOffset.UtcNow, new[] { builtInCatalog, next }),
                (_, _) => Task.FromResult(unsafeBytes),
                CancellationToken.None);
            Equal(1, failed.RequiredUnavailable, "invalid replacement is reported as required and unavailable");
            False(restarted.RequiredReady(), "claim readiness closes when a required replacement is invalid");
            True(
                restarted.TryResolve(managed.AssetKey, managed, out var preserved)
                    && restarted.Read(preserved).Bytes.SequenceEqual(managedBytes),
                "failed replacement does not delete the previous verified revision");

            var managedPath = managed.DownloadPath!.Split('/')
                .Aggregate(cacheRoot, Path.Combine);
            await File.WriteAllTextAsync(managedPath, "corrupted");
            var afterCorruption = await restarted.ReadyRevisionsAsync();
            False(afterCorruption.Any(item => item.AssetId == managed.AssetId),
                "corrupted cached bytes are removed from exact readiness before reporting");
            Equal(0, restarted.Status().ManagedCount,
                "managed status count is recomputed after corrupt readiness removal");
            False(restarted.RequiredReady(),
                "overall readiness closes after a required cached revision is corrupted");
        }
    }

    private static async Task OverlayDisplayPriorityTestsAsync(string root)
    {
        var cache = new OverlayAssetCache(Path.Combine(root, "overlay-display-priority"));
        using var service = new ByeollogOverlayService(
            new CollectorStorage(),
            cache,
            AvailableLoopbackPort());
        True(service.TryStart(), "overlay display priority test starts a loopback-only server");

        False(
            await service.WaitForBrowserSourceAsync(
                TimeSpan.FromMilliseconds(250),
                CancellationToken.None),
            "overlay readiness fails closed before any OBS browser source polls state");
        var browserReady = service.WaitForBrowserSourceAsync(
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        await Task.Delay(100);
        using (var http = new HttpClient(new HttpClientHandler { UseProxy = false }))
        {
            _ = await http.GetStringAsync($"{service.OverlayUrl}/state");
            var waterMotion = await http.GetByteArrayAsync(
                $"{service.OverlayUrl}/builtin/water-splash-v4.webm");
            Equal(7_879_928, waterMotion.Length,
                "the loopback overlay serves the complete built-in FLIP water motion");
            Equal(
                OverlayAssetCache.WaterSplashMotionContentSha256,
                OverlayAssetValidator.Sha256Hex(waterMotion),
                "the served FLIP water motion retains its sealed digest");
            var fireworksMotion = await http.GetByteArrayAsync(
                $"{service.OverlayUrl}/builtin/modern-confetti-v3.webm");
            Equal(1_052_026, fireworksMotion.Length,
                "the loopback overlay serves the complete modern confetti motion");
            Equal(
                OverlayAssetCache.FireworksMotionContentSha256,
                OverlayAssetValidator.Sha256Hex(fireworksMotion),
                "the served modern confetti motion retains its sealed digest");
        }
        True(
            await browserReady,
            "overlay readiness opens only after a browser source polls the loopback state endpoint");
        True(
            service.Telemetry().LastStateRequestAtUtc is not null,
            "overlay telemetry records the last real browser-source state request");

        True(
            ByeollogOverlayService.IsMatchingLoopbackOverlayUrl(
                "http://localhost:43120/overlay/",
                "http://127.0.0.1:43120/overlay"),
            "overlay refresh matching accepts equivalent localhost loopback URLs");
        False(
            ByeollogOverlayService.IsMatchingLoopbackOverlayUrl(
                "http://127.0.0.1:43121/overlay",
                "http://127.0.0.1:43120/overlay"),
            "overlay refresh matching rejects a different local port");
        False(
            ByeollogOverlayService.IsMatchingLoopbackOverlayUrl(
                "https://example.com/overlay",
                "http://127.0.0.1:43120/overlay"),
            "overlay refresh matching rejects non-loopback URLs");

        var preview = service.PreviewAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            10_000,
            expectedAsset: null,
            CancellationToken.None);
        await WaitUntilAsync(() => service.Snapshot().Active, TimeSpan.FromSeconds(2));

        var automationStarted = Stopwatch.StartNew();
        var automation = service.ShowAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            CancellationToken.None);
        False(
            await preview.WaitAsync(TimeSpan.FromSeconds(2)),
            "actual automation preempts an active preview");
        await automation.WaitAsync(TimeSpan.FromSeconds(3));
        True(
            automationStarted.Elapsed < TimeSpan.FromSeconds(2.5),
            "actual automation does not wait for the preview duration");

        var activeAutomation = service.ShowAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            CancellationToken.None);
        await WaitUntilAsync(() => service.Snapshot().Active, TimeSpan.FromSeconds(2));
        var failFast = Stopwatch.StartNew();
        False(
            await service.PreviewAsync(
                OverlayAssetCache.MicrophoneOffAssetKey,
                1_000,
                expectedAsset: null,
                CancellationToken.None),
            "preview fails closed while actual automation is active");
        True(
            failFast.Elapsed < TimeSpan.FromMilliseconds(500),
            "preview fails fast instead of queuing behind actual automation");
        await activeAutomation.WaitAsync(TimeSpan.FromSeconds(3));

        var accumulationRevision = service.Snapshot().Revision;
        var accumulatedFirst = service.ShowAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            CancellationToken.None);
        await WaitUntilAsync(() => service.Snapshot().Active, TimeSpan.FromSeconds(2));
        await Task.Delay(200);
        var accumulatedSecond = service.ShowAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            CancellationToken.None);
        await Task.Delay(950);
        True(
            service.Snapshot().Active,
            "a second Abong keeps the overlay continuously active beyond the first deadline");
        await Task.WhenAll(accumulatedFirst, accumulatedSecond).WaitAsync(TimeSpan.FromSeconds(3));
        False(service.Snapshot().Active, "the accumulated overlay becomes inactive after both durations");
        Equal(
            accumulationRevision + 3,
            service.Snapshot().Revision,
            "overlap updates content once and hides once without an inactive/active boundary flicker");

        var uninterruptedPreview = service.PreviewAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            1_000,
            expectedAsset: null,
            CancellationToken.None);
        await WaitUntilAsync(() => service.Snapshot().Active, TimeSpan.FromSeconds(2));
        var duplicateStarted = Stopwatch.StartNew();
        False(
            await service.PreviewAsync(
                OverlayAssetCache.MicrophoneOffAssetKey,
                1_000,
                expectedAsset: null,
                CancellationToken.None),
            "a duplicate preview fails closed without canceling the first preview");
        True(
            duplicateStarted.Elapsed < TimeSpan.FromMilliseconds(500),
            "a duplicate preview fails fast");
        using (var canceledAutomation = new CancellationTokenSource())
        {
            canceledAutomation.Cancel();
            await ThrowsAsync<OperationCanceledException>(
                () => service.ShowAsync(
                    OverlayAssetCache.MicrophoneOffAssetKey,
                    1_000,
                    expectedAsset: null,
                    canceledAutomation.Token),
                "an already-canceled automation request is rejected before it can preempt a preview");
        }
        True(
            await uninterruptedPreview.WaitAsync(TimeSpan.FromSeconds(3)),
            "a rejected duplicate and pre-canceled automation leave the first preview intact");

        var closingPreview = service.PreviewAsync(
            OverlayAssetCache.MicrophoneOffAssetKey,
            10_000,
            expectedAsset: null,
            CancellationToken.None);
        await WaitUntilAsync(() => service.Snapshot().Active, TimeSpan.FromSeconds(2));
        service.Dispose();
        False(
            await closingPreview.WaitAsync(TimeSpan.FromSeconds(2)),
            "service shutdown cancels preview without a disposed-gate race");
        Throws<ObjectDisposedException>(
            () => service.TryStart(),
            "disposed overlay service cannot be restarted");
    }

    private static int AvailableLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (condition()) return;
            await Task.Delay(10);
        }
        if (!condition())
            throw new InvalidOperationException("ASSERT TIMEOUT FAILED: expected condition did not become true");
    }

    private static async Task TimedMuteTestsAsync()
    {
        using var valid = JsonDocument.Parse("{\"target\":\"microphone\",\"durationMs\":3000}");
        True(
            TimedMuteContract.TryReadStrictParameters(valid.RootElement, "microphone", out var durationMs),
            "valid timed mute parameters are accepted");
        Equal(3000, durationMs, "timed mute duration is parsed exactly");

        using var withOverlay = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off\"}");
        True(
            TimedMuteContract.TryReadObsParameters(
                withOverlay.RootElement,
                out var overlayDurationMs,
                out var overlayAssetKey),
            "OBS timed mute accepts the built-in Byeollog overlay asset");
        Equal(10000, overlayDurationMs, "overlay duration is tied to timed mute duration");
        Equal("mic_off", overlayAssetKey, "overlay uses only the managed asset key");

        using var withCustomPosition = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off_center\",\"overlayPositionX\":1234,\"overlayPositionY\":5678}");
        True(
            TimedMuteContract.TryReadObsParameters(
                withCustomPosition.RootElement,
                out _,
                out _,
                out var customPosition),
            "OBS timed mute accepts one bounded custom overlay position pair");
        Equal(1234, customPosition?.XBasisPoints, "custom overlay horizontal position is exact");
        Equal(5678, customPosition?.YBasisPoints, "custom overlay vertical position is exact");

        using var withRuntimeImageKey = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayImageKey\":\"mic_off_signal_panel\",\"overlayPositionX\":4321,\"overlayPositionY\":6789,\"overlayScalePercent\":125}");
        True(
            TimedMuteContract.TryReadObsParameters(
                withRuntimeImageKey.RootElement,
                out _,
                out var runtimeImageKey,
                out var runtimePlacement),
            "the runtime mirror image key is accepted without weakening the legacy DB constraint");
        Equal("mic_off_signal_panel", runtimeImageKey,
            "the runtime mirror preserves the selected packaged image");
        Equal(125, runtimePlacement?.ScalePercent,
            "the runtime mirror preserves the selected image size");

        using var duplicateImageKeys = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off\",\"overlayImageKey\":\"mic_off_signal_panel\"}");
        False(
            TimedMuteContract.TryReadObsParameters(duplicateImageKeys.RootElement, out _, out _, out _),
            "legacy and runtime image keys cannot be supplied together");

        using var withAssetIdAndScale = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetId\":\"b3bbf63e-4464-560d-aaa6-87bb7477ffa9\",\"overlayPositionX\":5000,\"overlayPositionY\":5000,\"overlayScalePercent\":135}");
        True(
            TimedMuteContract.TryReadObsParameters(
                withAssetIdAndScale.RootElement,
                out _,
                out var idMappedKey,
                out var scaledPlacement),
            "v6 overlay UUID and bounded size resolve through the compiled allowlist");
        Equal("mic_off_badge", idMappedKey, "the distinct badge UUID maps to its exact built-in key");
        Equal(135, scaledPlacement?.ScalePercent, "custom overlay scale is exact");

        using var unknownAssetId = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\"}");
        False(
            TimedMuteContract.TryReadObsParameters(unknownAssetId.RootElement, out _, out _, out _),
            "an overlay UUID outside the compiled allowlist is rejected");

        using var outOfRangeScale = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off_center\",\"overlayPositionX\":5000,\"overlayPositionY\":5000,\"overlayScalePercent\":205}");
        False(
            TimedMuteContract.TryReadObsParameters(outOfRangeScale.RootElement, out _, out _, out _),
            "overlay scale outside 25 to 200 percent is rejected");

        using var incompletePosition = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off_center\",\"overlayPositionX\":1234}");
        False(
            TimedMuteContract.TryReadObsParameters(incompletePosition.RootElement, out _, out _, out _),
            "an incomplete overlay position pair is rejected");
        using var outOfRangePosition = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"mic_off_center\",\"overlayPositionX\":10001,\"overlayPositionY\":5000}");
        False(
            TimedMuteContract.TryReadObsParameters(outOfRangePosition.RootElement, out _, out _, out _),
            "an out-of-bounds overlay position is rejected");

        using var windowsWithOverlay = JsonDocument.Parse(
            "{\"target\":\"selected_capture_device\",\"durationMs\":17000,\"overlayAssetKey\":\"mic_off\"}");
        True(
            TimedMuteContract.TryReadWindowsParameters(
                windowsWithOverlay.RootElement,
                out var windowsOverlayDurationMs,
                out var windowsOverlayAssetKey),
            "Windows timed mute accepts the same managed overlay contract");
        Equal(17000, windowsOverlayDurationMs, "Windows overlay duration follows the direct user input");
        Equal("mic_off", windowsOverlayAssetKey, "Windows overlay uses only the managed asset key");

        using var unknownOverlay = JsonDocument.Parse(
            "{\"target\":\"microphone\",\"durationMs\":10000,\"overlayAssetKey\":\"../../secret\"}");
        False(
            TimedMuteContract.TryReadObsParameters(unknownOverlay.RootElement, out _, out _),
            "arbitrary overlay paths and keys are rejected");
        False(
            TimedMuteContract.TryReadStrictParameters(withOverlay.RootElement, "microphone", out _),
            "overlay fields are not silently accepted by non-overlay contracts");

        using var extra = JsonDocument.Parse("{\"target\":\"microphone\",\"durationMs\":3000,\"muted\":true}");
        False(
            TimedMuteContract.TryReadStrictParameters(extra.RootElement, "microphone", out _),
            "unknown timed mute fields are rejected");
        using var tooShort = JsonDocument.Parse("{\"target\":\"microphone\",\"durationMs\":999}");
        False(
            TimedMuteContract.TryReadStrictParameters(tooShort.RootElement, "microphone", out _),
            "unsafe short timed mute duration is rejected");
        using var multipliedMaximum = JsonDocument.Parse("{\"target\":\"microphone\",\"durationMs\":900000}");
        True(
            TimedMuteContract.TryReadStrictParameters(multipliedMaximum.RootElement, "microphone", out var multipliedDurationMs),
            "a server-multiplied timed mute is accepted up to the bounded fifteen-minute ceiling");
        Equal(900_000, multipliedDurationMs, "the multiplied duration is preserved exactly");
        using var multipliedTooLong = JsonDocument.Parse("{\"target\":\"microphone\",\"durationMs\":900001}");
        False(
            TimedMuteContract.TryReadStrictParameters(multipliedTooLong.RootElement, "microphone", out _),
            "a multiplied timed mute above the bounded ceiling is rejected");

        var observedAt = DateTimeOffset.UtcNow;
        True(
            TimedMuteContract.WasOverlayDisplayObserved(12, 13, observedAt),
            "a Browser Source active-state read proves display even when the exact image stays cached");
        False(
            TimedMuteContract.WasOverlayDisplayObserved(12, 12, observedAt),
            "a cached image alone cannot prove that the Browser Source observed this activation");
        False(
            TimedMuteContract.WasOverlayDisplayObserved(12, 13, null),
            "an active-state counter without its observation timestamp fails closed");

        var gate = new SemaphoreSlim(1, 1);
        var successStore = new MemoryRecoveryStore();
        var successTarget = new FakeTimedMuteTarget(false);
        var success = await new TimedMuteCoordinator(
            successStore,
            gate,
            (_, _) => Task.CompletedTask).ExecuteAsync(successTarget, 1000, CancellationToken.None);
        False(success.InitialMuted, "unmuted target state is captured");
        True(success.Changed && success.MutedVerified && success.RestoredVerified, "mute and restoration are verified");
        False(successTarget.Muted, "successful timed mute restores unmuted state");
        Equal<TimedMuteRecoveryRecord?>(null, successStore.Record, "successful timed mute clears recovery journal");

        var queuedClock = DateTimeOffset.Parse("2026-08-25T00:00:00Z");
        var queuedGate = new SemaphoreSlim(1, 1);
        await queuedGate.WaitAsync();
        var queuedStore = new MemoryRecoveryStore();
        var queuedTarget = new FakeTimedMuteTarget(false);
        var queuedAccepted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var queuedCoordinator = new TimedMuteCoordinator(
            queuedStore,
            queuedGate,
            (_, _) => Task.CompletedTask,
            () => queuedClock);
        var queuedUntilExpired = queuedCoordinator.ExecuteAsync(
            queuedTarget,
            1_000,
            CancellationToken.None,
            () => queuedAccepted.TrySetResult(true),
            notAfterUtc: queuedClock.AddMinutes(1));
        await queuedAccepted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        queuedClock = queuedClock.AddMinutes(2);
        queuedGate.Release();
        await ThrowsAsync<VNextActionExpiredException>(
            () => queuedUntilExpired,
            "a timed action that expires behind the global mutation gate never activates later");
        Equal(0, queuedTarget.MuteCalls, "queued expiry performs no target mutation");
        Equal<TimedMuteRecoveryRecord?>(null, queuedStore.Record, "queued expiry creates no recovery journal");

        var separatedGate = new SemaphoreSlim(1, 1);
        var separatedStore = new MemoryRecoveryStore();
        var separatedTarget = new FakeTimedMuteTarget(false);
        var previewDelay = new ControlledDelay();
        var previewCoordinator = new TimedMuteCoordinator(
            separatedStore,
            separatedGate,
            previewDelay.DelayAsync);
        var productionCoordinator = new TimedMuteCoordinator(
            separatedStore,
            separatedGate,
            (_, _) => Task.CompletedTask);
        using var previewStop = new CancellationTokenSource();
        var previewRun = previewCoordinator.ExecuteAsync(
            separatedTarget,
            5_000,
            previewStop.Token);
        _ = await previewDelay.NextAsync();
        var productionAccepted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var productionRun = productionCoordinator.ExecuteAsync(
            separatedTarget,
            3_000,
            CancellationToken.None,
            () => productionAccepted.TrySetResult(true),
            notAfterUtc: DateTimeOffset.UtcNow.AddMinutes(1));
        await productionAccepted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        previewStop.Cancel();
        await ThrowsAsync<TimedMuteCanceledAfterRestoreException>(
            () => previewRun,
            "canceling a preview restores only the isolated preview session");
        var productionResult = await productionRun;
        True(productionResult.RestoredVerified, "the queued production action still runs and restores after preview cancellation");
        Equal(2, separatedTarget.MuteCalls, "preview and production use two distinct physical activations");
        Equal(2, separatedTarget.UnmuteCalls, "preview cancellation cannot restore the later production activation");
        False(separatedTarget.Muted, "separated preview and production both finish at the original state");

        var accumulatingStore = new MemoryRecoveryStore();
        var accumulatingTarget = new FakeTimedMuteTarget(false);
        var controlledDelay = new ControlledDelay();
        var accumulatingCoordinator = new TimedMuteCoordinator(
            accumulatingStore,
            gate,
            controlledDelay.DelayAsync);
        var accumulationActivated = 0;
        var firstAccumulated = accumulatingCoordinator.ExecuteAsync(
            accumulatingTarget,
            1_000,
            CancellationToken.None,
            onActivated: () =>
            {
                True(accumulatingTarget.Muted,
                    "leader activation callback runs only after mute verification");
                Interlocked.Increment(ref accumulationActivated);
            });
        var firstSegment = await controlledDelay.NextAsync();
        Equal(TimeSpan.FromSeconds(1), firstSegment.Duration, "first Abong schedules its exact duration");
        True(accumulatingTarget.Muted, "first Abong mutes before its duration begins");

        var secondAccumulated = accumulatingCoordinator.ExecuteAsync(
            accumulatingTarget,
            1_000,
            CancellationToken.None,
            onActivated: () =>
            {
                True(accumulatingTarget.Muted,
                    "follower activation callback sees the continuously muted session");
                Interlocked.Increment(ref accumulationActivated);
            });
        await Task.Delay(25);
        Equal(2, Volatile.Read(ref accumulationActivated),
            "each accumulated Abong can synchronize its overlay without a second mute transition");
        Equal(1, accumulatingTarget.MuteCalls, "overlapping Abong does not issue a second mute transition");
        Equal(0, accumulatingTarget.UnmuteCalls, "overlapping Abong cannot restore at the first boundary");
        firstSegment.Release.TrySetResult(true);
        var secondSegment = await controlledDelay.NextAsync();
        Equal(TimeSpan.FromSeconds(1), secondSegment.Duration, "second Abong duration is appended in full");
        True(accumulatingTarget.Muted, "the microphone remains muted between accumulated segments");
        Equal(0, accumulatingTarget.UnmuteCalls, "there is no unmute flicker between accumulated segments");
        secondSegment.Release.TrySetResult(true);
        var accumulatedResults = await Task.WhenAll(firstAccumulated, secondAccumulated);
        Equal(1, accumulatingTarget.MuteCalls, "the accumulated session mutes exactly once");
        Equal(1, accumulatingTarget.UnmuteCalls, "the accumulated session restores exactly once");
        False(accumulatingTarget.Muted, "the accumulated session restores the original state at the final deadline");
        Equal(1_000, accumulatedResults[0].DurationMs, "first ACK preserves its requested duration");
        Equal(1_000, accumulatedResults[1].DurationMs, "second ACK preserves its requested duration");

        var isolatedCancellationStore = new MemoryRecoveryStore();
        var isolatedCancellationTarget = new FakeTimedMuteTarget(false);
        var isolatedCancellationDelay = new ControlledDelay();
        var isolatedCancellationCoordinator = new TimedMuteCoordinator(
            isolatedCancellationStore,
            gate,
            isolatedCancellationDelay.DelayAsync);
        var acceptedCount = 0;
        var protectedLeader = isolatedCancellationCoordinator.ExecuteAsync(
            isolatedCancellationTarget,
            1_000,
            CancellationToken.None,
            () => Interlocked.Increment(ref acceptedCount));
        var protectedFirstSegment = await isolatedCancellationDelay.NextAsync();
        using var followerStop = new CancellationTokenSource();
        var canceledFollower = isolatedCancellationCoordinator.ExecuteAsync(
            isolatedCancellationTarget,
            1_000,
            followerStop.Token,
            () => Interlocked.Increment(ref acceptedCount));
        await Task.Delay(25);
        Equal(2, Volatile.Read(ref acceptedCount), "each overlapping Abong releases its admission slot after joining");
        followerStop.Cancel();
        protectedFirstSegment.Release.TrySetResult(true);
        var protectedSecondSegment = await isolatedCancellationDelay.NextAsync();
        True(isolatedCancellationTarget.Muted, "canceling one accepted follower cannot end the shared mute session");
        Equal(0, isolatedCancellationTarget.UnmuteCalls, "a participant cancellation cannot restore the shared session early");
        protectedSecondSegment.Release.TrySetResult(true);
        await Task.WhenAll(protectedLeader, canceledFollower);
        Equal(1, isolatedCancellationTarget.MuteCalls, "participant cancellation keeps one physical mute transition");
        Equal(1, isolatedCancellationTarget.UnmuteCalls, "participant cancellation still restores exactly once at the accumulated deadline");
        False(isolatedCancellationTarget.Muted, "participant cancellation preserves final restoration");

        var initiallyMutedStore = new MemoryRecoveryStore();
        var initiallyMutedTarget = new FakeTimedMuteTarget(true);
        var initiallyMuted = await new TimedMuteCoordinator(
            initiallyMutedStore,
            gate,
            (_, _) => Task.CompletedTask).ExecuteAsync(initiallyMutedTarget, 1000, CancellationToken.None);
        True(initiallyMuted.InitialMuted, "initial muted state is captured");
        False(initiallyMuted.Changed, "already-muted target is not exposed");
        True(initiallyMutedTarget.Muted, "already-muted target remains muted");

        var canceledStore = new MemoryRecoveryStore();
        var canceledTarget = new FakeTimedMuteTarget(false);
        await ThrowsAsync<TimedMuteCanceledAfterRestoreException>(
            () => new TimedMuteCoordinator(
                canceledStore,
                gate,
                (_, _) => throw new OperationCanceledException()).ExecuteAsync(
                    canceledTarget,
                    1000,
                    CancellationToken.None),
            "canceled timed mute reports cancellation after restoration");
        False(canceledTarget.Muted, "canceled timed mute restores original state");
        Equal<TimedMuteRecoveryRecord?>(null, canceledStore.Record, "canceled timed mute clears journal after restoration");

        var recoveryStore = new MemoryRecoveryStore();
        var recoveryTarget = new FakeTimedMuteTarget(false) { FailUnmute = true };
        await ThrowsAsync<TimedMuteRestoreFailedException>(
            () => new TimedMuteCoordinator(
                recoveryStore,
                gate,
                (_, _) => Task.CompletedTask).ExecuteAsync(
                    recoveryTarget,
                    1000,
                    CancellationToken.None),
            "failed restoration is surfaced as uncertain");
        True(recoveryTarget.Muted, "failed restoration leaves observable muted fixture");
        True(recoveryStore.Record is not null, "failed restoration preserves recovery journal");

        recoveryTarget.FailUnmute = false;
        var recovered = await new TimedMuteCoordinator(
            recoveryStore,
            gate,
            (_, _) => Task.CompletedTask).RecoverAsync(_ => recoveryTarget, CancellationToken.None);
        True(recovered.HadPendingOperation && recovered.RestoredVerified, "startup recovery restores pending operation");
        False(recoveryTarget.Muted, "startup recovery restores exact original state");
        Equal<TimedMuteRecoveryRecord?>(null, recoveryStore.Record, "startup recovery clears journal");
    }

    private static void VNextSourceIdentityTests()
    {
        Equal("weflab-uid-1", VNextSourceIdentity.RequireValid("  weflab-uid-1  "), "source UID is trimmed and preserved");
        Equal(new string('a', 256), VNextSourceIdentity.RequireValid(new string('a', 256)), "256-character source UID is accepted");
        Throws<InvalidDataException>(() => VNextSourceIdentity.RequireValid(""), "empty source UID is rejected");
        Throws<InvalidDataException>(() => VNextSourceIdentity.RequireValid(new string('a', 257)), "oversized source UID is rejected");
        Throws<InvalidDataException>(() => VNextSourceIdentity.RequireValid("bad|uid"), "pipe in source UID is rejected");
        Throws<InvalidDataException>(() => VNextSourceIdentity.RequireValid("bad\nuid"), "control character in source UID is rejected");
    }

    private static void AutomationRpcSerializationTests()
    {
        var drafts = new[]
        {
            new VNextAutomationRuleRpc(
                "11111111-1111-4111-8111-111111111111",
                "업보 생성",
                true,
                100,
                "weflab",
                "roulette",
                null,
                "당첨",
                null,
                "upbo.apply",
                "테스트",
                ["memo"],
                1,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null),
            new VNextAutomationRuleRpc(
                "11111111-1111-4111-8111-111111111111",
                "OBS 수정",
                true,
                100,
                "byeollog",
                "donation",
                null,
                null,
                1000,
                "obs.mute_for",
                null,
                null,
                null,
                10,
                "22222222-2222-4222-8222-222222222222",
                OverlayAssetCache.MicrophoneOffCenterAssetKey,
                5000,
                5000,
                100,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                "44444444-4444-4444-8444-444444444444",
                7),
            new VNextAutomationRuleRpc(
                "11111111-1111-4111-8111-111111111111",
                "Windows 마이크",
                false,
                100,
                "weflab",
                "donation",
                "video",
                null,
                null,
                "windows.mic_mute_for",
                null,
                null,
                null,
                5,
                "22222222-2222-4222-8222-222222222222",
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null),
            new VNextAutomationRuleRpc(
                "11111111-1111-4111-8111-111111111111",
                "33개마다 추첨권",
                true,
                120,
                "weflab",
                "donation",
                null,
                null,
                33,
                "raffle.ticket_grant",
                null,
                null,
                null,
                null,
                "22222222-2222-4222-8222-222222222222",
                null,
                null,
                null,
                null,
                null,
                null,
                33,
                false,
                5000,
                5000,
                100,
                80,
                5000,
                5000,
                100,
                80,
                null,
                null,
                null,
                null,
                null,
                null,
                null)
        };
        var expectedKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "p_workspace_id", "p_replace_rule_id", "p_expected_version", "p_name",
            "p_enabled", "p_priority", "p_source", "p_event_type", "p_subtype",
            "p_result", "p_min_amount", "p_action_type", "p_event_name",
            "p_output_types", "p_quantity", "p_duration_seconds",
            "p_agent_device_id", "p_overlay_image_key", "p_overlay_position_x",
            "p_overlay_position_y", "p_overlay_scale_percent",
            "p_reward_multiplier", "p_allow_multiplier_stacking", "p_raffle_ticket_unit",
            "p_raffle_allow_multiples", "p_raffle_ticket_position_x",
            "p_raffle_ticket_position_y", "p_raffle_ticket_scale_percent",
            "p_raffle_draw_position_x", "p_raffle_draw_position_y",
            "p_raffle_draw_scale_percent", "p_raffle_ticket_volume_percent",
            "p_raffle_draw_volume_percent", "p_flashbang_intensity",
            "p_flashbang_volume_percent", "p_voice_preset",
            "p_visual_variant", "p_visual_volume_percent"
        };

        foreach (var draft in drafts)
        {
            using var document = JsonDocument.Parse(VNextAutomationRpcSerializer.Serialize(draft));
            var actualKeys = document.RootElement.EnumerateObject()
                .Select(property => property.Name)
                .ToHashSet(StringComparer.Ordinal);
            Equal(expectedKeys.Count, actualKeys.Count, "guided-rule RPC emits the exact versioned named arguments");
            True(expectedKeys.SetEquals(actualKeys), "guided-rule RPC preserves the exact PostgREST signature");
        }

        using var createDocument = JsonDocument.Parse(VNextAutomationRpcSerializer.Serialize(drafts[0]));
        Equal(JsonValueKind.Null, createDocument.RootElement.GetProperty("p_replace_rule_id").ValueKind,
            "create RPC keeps a null replacement ID");
        Equal(JsonValueKind.Null, createDocument.RootElement.GetProperty("p_expected_version").ValueKind,
            "create RPC keeps a null expected version");
        Equal(JsonValueKind.Null, createDocument.RootElement.GetProperty("p_agent_device_id").ValueKind,
            "upbo RPC keeps the unused Agent ID argument");
        Equal(JsonValueKind.Null, createDocument.RootElement.GetProperty("p_duration_seconds").ValueKind,
            "upbo RPC keeps the unused duration argument");
    }

    private static VNextAgentJob Job(
        string executionId,
        int attemptNo,
        string actionType,
        string actionParams,
        string agentDeviceId = "11111111-1111-1111-1111-111111111111",
        VNextOverlayAssetDescriptor? overlayAsset = null)
    {
        using var document = JsonDocument.Parse(actionParams);
        return new VNextAgentJob(
            executionId,
            executionId,
            "workspace-dev",
            "event-" + executionId,
            "local_agent",
            agentDeviceId,
            actionType,
            document.RootElement.Clone(),
            10_000,
            attemptNo,
            3,
            1,
            DateTimeOffset.UtcNow.AddSeconds(45),
            overlayAsset);
    }

    private static RafflePreparedAudio PreparedTestAudio(string bindingKey)
    {
        var audio = ByeollogRaffleAudio.TicketAudioForPreflight();
        return new RafflePreparedAudio(
            audio,
            Convert.ToHexString(SHA256.HashData(audio)).ToLowerInvariant(),
            bindingKey);
    }

    private static VNextOverlayAssetDescriptor ManagedDescriptor(
        string assetId,
        string assetKey,
        int versionNumber,
        byte[] bytes,
        bool required = false) => new(
            assetId,
            assetKey,
            versionNumber,
            "테스트 오버레이 이미지",
            "image/svg+xml",
            OverlayAssetValidator.Sha256Hex(bytes),
            bytes.Length,
            320,
            180,
            "managed_bundle",
            required,
            $"assets/{assetId}/v{versionNumber}/{OverlayAssetValidator.Sha256Hex(bytes)}.svg");

    private static void True(bool condition, string message)
    {
        _assertions++;
        if (!condition) throw new InvalidOperationException("ASSERT TRUE FAILED: " + message);
    }

    private static void False(bool condition, string message) => True(!condition, message);

    private static void Equal<T>(T expected, T actual, string message)
    {
        _assertions++;
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"ASSERT EQUAL FAILED: {message}; expected={expected}; actual={actual}");
    }

    private static void Throws<TException>(Action action, string message) where TException : Exception
    {
        _assertions++;
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException($"ASSERT THROWS FAILED: {message}; expected={typeof(TException).Name}");
    }

    private static void ThrowsAny(Action action, string message)
    {
        _assertions++;
        try
        {
            action();
        }
        catch
        {
            return;
        }
        throw new InvalidOperationException($"ASSERT THROWS FAILED: {message}; expected any exception");
    }

    private static async Task ThrowsAsync<TException>(Func<Task> action, string message) where TException : Exception
    {
        _assertions++;
        try
        {
            await action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException($"ASSERT THROWS FAILED: {message}; expected={typeof(TException).Name}");
    }

    private sealed class MemoryRecoveryStore : ITimedMuteRecoveryStore
    {
        private readonly object _gate = new();
        private TimedMuteRecoveryRecord? _record;
        public TimedMuteRecoveryRecord? Record { get { lock (_gate) return _record; } }
        public TimedMuteRecoveryRecord? Load() { lock (_gate) return _record; }
        public void Save(TimedMuteRecoveryRecord record) { lock (_gate) _record = record; }
        public void Clear(string operationId)
        {
            lock (_gate)
            {
                if (_record?.OperationId != operationId) throw new InvalidOperationException("operation mismatch");
                _record = null;
            }
        }
    }

    private sealed class ScriptedUpdateHandler : HttpMessageHandler
    {
        private readonly Queue<Func<Uri, HttpResponseMessage>> _responses;

        internal ScriptedUpdateHandler(params Func<Uri, HttpResponseMessage>[] responses) =>
            _responses = new Queue<Func<Uri, HttpResponseMessage>>(responses);

        internal List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (request.Method != HttpMethod.Get || request.RequestUri is null)
                throw new InvalidOperationException("The updater test expected an absolute GET request.");
            if (_responses.Count == 0)
                throw new InvalidOperationException("The updater issued more requests than the scripted test permits.");

            Requests.Add(request.RequestUri);
            return Task.FromResult(_responses.Dequeue()(request.RequestUri));
        }
    }

    private sealed record ControlledDelayCall(TimeSpan Duration, TaskCompletionSource<bool> Release);

    private sealed class ControlledDelay
    {
        private readonly object _gate = new();
        private readonly Queue<ControlledDelayCall> _calls = new();
        private readonly SemaphoreSlim _available = new(0);

        public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken)
        {
            var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_gate) _calls.Enqueue(new ControlledDelayCall(duration, release));
            _available.Release();
            return AwaitReleaseAsync(release, cancellationToken);
        }

        public async Task<ControlledDelayCall> NextAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await _available.WaitAsync(timeout.Token);
            lock (_gate) return _calls.Dequeue();
        }

        private static async Task AwaitReleaseAsync(
            TaskCompletionSource<bool> release,
            CancellationToken cancellationToken)
        {
            using var registration = cancellationToken.Register(
                static state => ((TaskCompletionSource<bool>)state!).TrySetCanceled(),
                release);
            await release.Task;
        }
    }

    private sealed class FakeTimedMuteTarget : ITimedMuteTarget
    {
        public FakeTimedMuteTarget(bool muted) => Muted = muted;
        public string TargetType => "fake";
        public string TargetKey => "fake-target";
        public bool Muted { get; private set; }
        public bool FailUnmute { get; set; }
        public int MuteCalls { get; private set; }
        public int UnmuteCalls { get; private set; }
        public Task<bool> GetMutedAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Muted);
        }
        public Task SetMutedAsync(bool muted, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!muted && FailUnmute) throw new IOException("simulated restoration failure");
            if (muted) MuteCalls++;
            else UnmuteCalls++;
            Muted = muted;
            return Task.CompletedTask;
        }
    }
}
