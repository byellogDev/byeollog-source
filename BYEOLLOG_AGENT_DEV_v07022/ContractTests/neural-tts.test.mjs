import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFile(new URL(path, root), "utf8");

test("raffle ticket and winner speech use the managed donation TTS path", async () => {
  const [client, agent, adapter, form, overlay] = await Promise.all([
    text("VNextDevelopmentClient.cs"),
    text("VNextLocalAgent.cs"),
    text("RaffleOverlayActionAdapter.cs"),
    text("VNextAutomationSettingsForm.cs"),
    text("ByeollogOverlayService.cs")
  ]);

  assert.match(client, /DownloadRaffleActionSpeechAsync/);
  assert.match(client, /operation\s*=\s*"raffle_action_tts"/);
  assert.match(client, /speechKind/);
  assert.match(client, /expectedBindingKey/);
  assert.match(client, /x-byeollog-audio-sha256/);
  assert.match(client, /x-byeollog-voice-key/);
  assert.match(client, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(agent, /DownloadRaffleActionSpeechAsync\([\s\S]*"ticket"/);
  assert.match(agent, /DownloadRaffleActionSpeechAsync\([\s\S]*"winner"/);
  assert.equal((agent.match(/"managed_donation_tts"/g) ?? []).length, 2);
  assert.doesNotMatch(agent, /TicketAudioForPreflight\(\)/);
  assert.doesNotMatch(agent, /WinnerFallbackAudioForPreflight\(\)/);
  assert.doesNotMatch(agent, /private readonly RaffleWinnerSpeechCache/);
  assert.match(adapter, /TicketAudioBindingKey\s*=\s*"[0-9a-f]{64}"/);
  assert.match(adapter, /TicketSpeechPreparation\(executionId, attemptNo/);
  assert.match(adapter, /WinnerSpeechPreparation\([\s\S]*executionId,[\s\S]*attemptNo/);
  assert.ok(
    adapter.indexOf("var preparedSpeech = await PrepareSpeechBestEffortAsync") <
      adapter.indexOf("var synchronized = await _overlay.ShowObservedAudioTransientAsync"),
    "managed speech must be ready before the overlay is made active"
  );
  assert.doesNotMatch(form, /당첨 후보 음성을 안전하게 준비하는 중이에요/);
  assert.doesNotMatch(form, /PrewarmRaffleWinnerSpeechAsync/);
  assert.match(overlay, /\/overlay\/audio\//);
  assert.match(overlay, /audioPresentationRevision/);
});

test("managed TTS failure remains visual-only instead of using local fallback speech", async () => {
  const [adapter, agent] = await Promise.all([
    text("RaffleOverlayActionAdapter.cs"),
    text("VNextLocalAgent.cs")
  ]);
  assert.match(adapter, /PrepareSpeechBestEffortAsync/);
  assert.match(adapter, /FailureType = ex\.GetType\(\)\.Name/);
  assert.doesNotMatch(agent, /embedded_fallback/);
  assert.doesNotMatch(agent, /내장 예비 음성/);
});
