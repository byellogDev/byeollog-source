import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("voice anonymizer is an end-to-end Windows Agent capability", async () => {
  const [capabilities, localAgent, client, readiness] = await Promise.all([
    source("VNextAgentCapabilities.cs"),
    source("VNextLocalAgent.cs"),
    source("VNextAutomationClient.cs"),
    source("BroadcastReadiness.cs")
  ]);

  assert.match(capabilities, /"obs\.voice_anonymize_for"/);
  assert.match(capabilities, /"obs\.voice_anonymize_for_v2"/);
  assert.match(localAgent, /TimedMuteActionAdapter\.VoiceAnonymizerActionType/);
  assert.match(localAgent, /ExecuteVoiceAnonymizerAsync/);
  assert.match(client, /save_guided_rule_v15/);
  assert.match(client, /dispatch_guided_rule_test_v5/);
  assert.match(client, /"obs\.voice_anonymize_for"/);
  assert.match(client, /"obs\.voice_anonymize_for_v2"/);
  assert.match(client, /ObsVoiceAnonymizerContract\.DownPreset/);
  assert.match(client, /ObsVoiceAnonymizerContract\.UpPreset/);
  assert.match(readiness, /TimedMuteActionAdapter\.VoiceAnonymizerActionType/);
  assert.match(readiness, /TimedMuteActionAdapter\.VoiceAnonymizerPresetActionType/);
});

test("remote payload cannot select an arbitrary local OBS filter", async () => {
  const [core, adapter] = await Promise.all([
    source("TimedMuteActionCore.cs"),
    source("TimedMuteActionAdapter.cs")
  ]);

  assert.match(core, /ActionLabel\s*=\s*"\(신원보호모드\/개발중\)"/);
  assert.match(core, /ControlType\s*=\s*"voice_anonymize"/);
  assert.match(core, /DownPreset\s*=\s*"anonymous_low"/);
  assert.match(core, /UpPreset\s*=\s*"anonymous_high"/);
  assert.match(core, /count\s*!=\s*7/);
  assert.doesNotMatch(core, /obsFilterName/);
  assert.match(adapter, /LoadObsSettings\(\)/);
  assert.match(adapter, /settings\.VoiceAnonymizerFilterName/);
  assert.match(adapter, /settings\.VoiceAnonymizerUpFilterName/);
  assert.match(adapter, /VoiceAnonymizerFilterKind\s*=\s*"vst_filter"/);
  assert.doesNotMatch(adapter, /sourceName\s*=\s*target\.SourceName/);
  assert.doesNotMatch(adapter, /filterName\s*=\s*target\.FilterName/);
  const safeVoiceFailure = adapter.slice(
    adapter.indexOf("private static string SafeVoiceAnonymizerFailure"),
    adapter.indexOf("private static VNextAgentOutcome Failure")
  );
  assert.doesNotMatch(safeVoiceFailure, /InvalidOperationException\s+\w+\s*=>\s*\w+\.Message/);
});

test("OBS WebSocket control uses the official 5.x source-filter requests", async () => {
  const websocket = await source("ObsWebSocketClient.cs");

  assert.match(websocket, /"GetSourceFilterList"/);
  assert.match(websocket, /"GetSourceFilter"/);
  assert.match(websocket, /"SetSourceFilterEnabled"/);
  assert.match(websocket, /returnedName\.Length > 0[\s\S]+!string\.Equals\(returnedName, filterName/);
  assert.match(websocket, /new ObsSourceFilterSummary\(filterName, kind, enabled\.GetBoolean\(\), index\)/);
  assert.doesNotMatch(websocket, /if \(!string\.Equals\(returnedName, filterName/);
  assert.doesNotMatch(websocket, /CreateSourceFilter/);
  assert.doesNotMatch(websocket, /SetSourceFilterSettings/);
});

test("streamer UI exposes the exact development label, readiness, and five-second preview", async () => {
  const [ui, form, storage, preflight] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("CollectorStorage.cs"),
    source("CollectorPreflight.cs")
  ]);

  assert.match(ui, /<strong>\(신원보호모드\/개발중\)<\/strong>/);
  assert.match(ui, /id="voiceFilterStatus"/);
  assert.match(ui, /id="voiceFilterName"/);
  assert.match(ui, /id="voiceUpFilterName"/);
  assert.match(ui, /두 톤 준비됨/);
  assert.match(ui, /id="previewVoiceButton"[^>]*>다운톤 5초<\/button>/);
  assert.match(ui, /id="previewVoiceUpButton"[^>]*>업톤 5초<\/button>/);
  assert.match(ui, /id="previewVoiceWizardButton"/);
  assert.match(ui, /value="anonymous_low"/);
  assert.match(ui, /value="anonymous_high"/);
  assert.match(ui, /post\('previewVoiceAnonymizer',\{preset/);
  assert.match(ui, /voiceSettingsDirty/);
  assert.match(ui, /localVoiceFilterReady/);
  assert.match(form, /RunLocalVoiceAnonymizerPreviewAsync|PreviewVoiceAnonymizerAsync/);
  assert.match(form, /SaveObsSettings\(settings\)/);
  assert.match(storage, /DefaultVoiceAnonymizerFilterName\s*=\s*"별록 신원보호모드"/);
  assert.match(storage, /DefaultVoiceAnonymizerUpFilterName\s*=\s*"별록 신원보호모드 업톤"/);
  assert.match(preflight, /"obs_voice_anonymizer"/);
  assert.match(preflight, /ProbeVoiceAnonymizerAsync/);
});

test("voice filter execution inherits snapshot, extension, and restart recovery semantics", async () => {
  const [adapter, core] = await Promise.all([
    source("TimedMuteActionAdapter.cs"),
    source("TimedMuteActionCore.cs")
  ]);

  assert.match(adapter, /_coordinator\.ExecuteAsync\(/);
  assert.match(adapter, /_voicePreviewCoordinator\.ExecuteAsync\(/);
  assert.match(adapter, /VoiceAnonymizerTargetType\s*=\s*"obs_source_filter"/);
  assert.match(adapter, /CreateVoiceAnonymizerRecoveryTarget/);
  assert.match(core, /AddDurationLocked/);
  assert.match(core, /InitialMuted/);
  assert.match(core, /TryRestoreAsync/);
  assert.match(core, /RecoverAsync/);
  assert.match(core, /notAfterUtc[\s\S]+RunPhysicalSessionAsync/);
});
