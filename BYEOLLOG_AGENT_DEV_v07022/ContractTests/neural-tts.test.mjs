import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const bytes = path => readFile(new URL(path, root));
const text = async path => (await bytes(path)).toString("utf8");

test("frequent raffle grants use one pinned local phrase without a local neural model", async () => {
  const [audio, project, player, adapter, localAgent, program] = await Promise.all([
    bytes("Assets/byeollog_raffle_ticket_fixed.wav"),
    text("HurogiCollector.csproj"),
    text("ByeollogRaffleAudio.cs"),
    text("RaffleOverlayActionAdapter.cs"),
    text("VNextLocalAgent.cs"),
    text("Program.cs")
  ]);

  assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(audio.length, 139928);
  assert.equal(
    createHash("sha256").update(audio).digest("hex"),
    "e0e1df2d38eacf60beed552fb5635f5e34282ba49b909e7b326ed76cd09f6811"
  );
  assert.match(project, /byeollog_raffle_ticket_fixed\.wav/);
  assert.match(project, /NAudio/);
  assert.doesNotMatch(project, /Microsoft\.ML\.OnnxRuntime/);
  assert.match(player, /TicketByteSize\s*=\s*139_928/);
  assert.match(player, /TicketSha256\s*=\s*\r?\n?\s*"e0e1df2d38eacf60beed552fb5635f5e34282ba49b909e7b326ed76cd09f6811"/);
  assert.match(player, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(player, /WaveFileReader/);
  assert.match(player, /WaveOutEvent/);
  assert.match(adapter, /TicketSpeechText\s*=\s*"추첨권을 드렸어요!"/);
  assert.match(adapter, /\$"\{displayName\}, 추첨권 \{granted\}장!"/);
  assert.doesNotMatch(adapter, /추첨함에 총/);
  assert.doesNotMatch(adapter, /KoreanTicketCounter/);
  assert.match(localAgent, /new RafflePreparedAudio\([\s\S]*ByeollogRaffleAudio\.TicketAudioForPreflight\(\)/);
  assert.doesNotMatch(localAgent, /ByeollogRaffleAudio\.PlayTicketAsync/);
  assert.doesNotMatch(program, /WarmupAsync/);
});

test("winner speech is bound to one winner identity, cached safely, and verified before playback", async () => {
  const [client, agent, adapter, form, cache, fallbackAudio, project, player, overlay] = await Promise.all([
    text("VNextDevelopmentClient.cs"),
    text("VNextLocalAgent.cs"),
    text("RaffleOverlayActionAdapter.cs"),
    text("VNextAutomationSettingsForm.cs"),
    text("RaffleWinnerSpeechCache.cs"),
    bytes("Assets/byeollog_raffle_winner_fallback.wav"),
    text("HurogiCollector.csproj"),
    text("ByeollogRaffleAudio.cs"),
    text("ByeollogOverlayService.cs")
  ]);

  assert.match(client, /DownloadRaffleWinnerSpeechAsync/);
  assert.match(client, /operation\s*=\s*"raffle_winner_tts"/);
  assert.match(client, /executionId/);
  assert.match(client, /attemptNo/);
  assert.match(client, /winnerOrdinal/);
  assert.match(client, /expectedVoiceKey/);
  assert.match(client, /x-byeollog-audio-sha256/);
  assert.match(client, /x-byeollog-voice-key/);
  assert.match(client, /x-byeollog-voice-version/);
  assert.match(client, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(client, /ValidateWinnerAudioForPreflight/);
  assert.match(client, /ListRaffleTtsCandidatesAsync/);
  assert.match(client, /DownloadRaffleCandidateSpeechAsync/);
  assert.match(client, /afterActorKey\s*=\s*cursor/);
  assert.match(client, /RaffleWinnerSpeechCache\.ComputeVoiceKey\(actorName\)/);
  assert.match(agent, /DownloadRaffleWinnerSpeechAsync\([\s\S]*executionId,[\s\S]*attemptNo,[\s\S]*winnerOrdinal,[\s\S]*expectedVoiceKey/);
  assert.match(agent, /PrewarmRaffleWinnerSpeechAsync/);
  assert.match(agent, /return new RafflePreparedAudio\([\s\S]*audioSha256,[\s\S]*expectedVoiceKey/);
  assert.match(agent, /WinnerFallbackAudioForPreflight\(\)/);
  assert.match(agent, /"embedded_fallback"/);
  assert.match(agent, /catch \(Exception ex\)[\s\S]*당첨 맞춤 음성 대신 내장 예비 음성 사용/);
  assert.doesNotMatch(agent, /ByeollogRaffleAudio\.PlayWinnerAsync/);
  assert.match(adapter, /WinnerSpeechPreparation\([\s\S]*executionId,[\s\S]*attemptNo,[\s\S]*index,[\s\S]*winnerVoiceKeys\[index\]/);
  assert.ok(
    adapter.indexOf("var preparedSpeech = await PrepareSpeechBestEffortAsync") <
      adapter.indexOf("var synchronized = await _overlay.ShowObservedAudioTransientAsync"),
    "winner audio must be prepared before the draw overlay is made active"
  );
  assert.match(adapter, /preparedSpeech\.Audio/);
  assert.match(adapter, /synchronized\.AudioEvidence\.Ended/);
  assert.match(adapter, /당첨 TTS 대상 키 없음[\s\S]*visual-only/);
  assert.match(cache, /raffle-winner-voice-v1\|/);
  assert.match(cache, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(cache, /FileMode\.CreateNew/);
  assert.match(cache, /FileAttributes\.ReparsePoint/);
  assert.match(cache, /ValidateWinnerAudioForPreflight/);
  assert.match(cache, /manifest\.VoiceKey/);
  assert.match(form, /당첨 후보 음성을 안전하게 준비하는 중이에요/);
  assert.match(form, /PrewarmRaffleWinnerSpeechAsync/);
  assert.match(form, /ByeollogRaffleAudio\.PlayWinnerPreviewAsync/);
  assert.match(form, /ByeollogRaffleAudio\.PlayTicketAsync/);
  assert.match(overlay, /\/overlay\/audio\//);
  assert.match(overlay, /audioPresentationRevision/);
  assert.match(overlay, /MaximumBrowserAudioPlaybackMs\s*=\s*25_000/);
  assert.doesNotMatch(form, /당첨 음성은 확정된 실행 기록으로만 생성됩니다/);
  assert.doesNotMatch(project, /byeollog_raffle_winner_preview\.wav/);
  assert.equal(fallbackAudio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(fallbackAudio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(fallbackAudio.length, 80684);
  assert.equal(
    createHash("sha256").update(fallbackAudio).digest("hex"),
    "ea566cc2bd872fad7d75684a9ce47ec3486c8d8fe50b3002ab470bbd9c536dea"
  );
  assert.match(project, /byeollog_raffle_winner_fallback\.wav/);
  assert.match(player, /WinnerFallbackSpeechText\s*=\s*"당첨을 축하드려요"/);
  assert.match(player, /WinnerFallbackByteSize\s*=\s*80_684/);
  assert.match(player, /WinnerFallbackSha256\s*=\s*\r?\n?\s*"ea566cc2bd872fad7d75684a9ce47ec3486c8d8fe50b3002ab470bbd9c536dea"/);
  assert.match(player, /PlayWinnerPreviewAsync[\s\S]*PlayWavAsync\(WinnerFallbackAudio\.Value/);
  assert.doesNotMatch(form, /ByeollogTextToSpeech/);
});
