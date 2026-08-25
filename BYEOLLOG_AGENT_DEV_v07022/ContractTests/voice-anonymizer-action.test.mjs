import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const binary = (name) => readFile(new URL(`../${name}`, import.meta.url));

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
  assert.match(adapter, /VoiceAnonymizerFilterKind\s*=\s*ObsVoiceFilterInstaller\.FilterKind/);
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
  assert.match(websocket, /"CreateSourceFilter"/);
  assert.match(websocket, /"RemoveSourceFilter"/);
  assert.match(websocket, /"GetSourceFilterKindList"/);
  assert.doesNotMatch(websocket, /SetSourceFilterSettings/);
});

test("voice filters use the pinned native plugin, migrate legacy ReaJS safely, and rollback", async () => {
  const [provisioner, installer, plugin, project] = await Promise.all([
    source("ObsVoiceAnonymizerProvisioner.cs"),
    source("ObsVoiceFilterInstaller.cs"),
    source("ObsPlugin/byeollog-voice-filter/plugin.cpp"),
    source("HurogiCollector.csproj")
  ]);

  assert.match(provisioner, /DownSemitones\s*=\s*-4/);
  assert.match(provisioner, /UpSemitones\s*=\s*4/);
  assert.match(provisioner, /ObsVoiceFilterInstaller\.FilterKind/);
  assert.match(provisioner, /GetSourceFilterKindListAsync/);
  assert.match(provisioner, /filterEnabled:\s*false/);
  assert.match(provisioner, /CreateSourceFilterAsync/);
  assert.match(provisioner, /RemoveSourceFilterAsync/);
  assert.match(provisioner, /created\.AsEnumerable\(\)\.Reverse\(\)/);
  assert.match(provisioner, /legacyBackups\.AsEnumerable\(\)\.Reverse\(\)/);
  assert.ok(
    provisioner.indexOf("createdFilters.Add(filterName)") < provisioner.indexOf("GetSourceFilterAsync(sourceName, filterName"),
    "new filter must enter rollback tracking before post-create verification"
  );
  assert.ok(
    provisioner.indexOf("RemoveSourceFilterAsync(sourceName, filter.FilterName") < provisioner.indexOf("legacyBackups.Add(new(filter.FilterName"),
    "legacy filter must enter restore tracking only after confirmed removal"
  );
  assert.match(provisioner, /LegacyReaJsFileName\s*=\s*"reajs\.dll"/);
  assert.match(provisioner, /기존 필터는 변경하지 않았습니다/);
  assert.doesNotMatch(provisioner, /SetSourceFilterSettingsAsync/);
  assert.doesNotMatch(provisioner, /File\.Write|WriteAllText|obs-studio\\basic\\scenes/);
  assert.match(installer, /FilterKind\s*=\s*"byeollog_voice_filter_v1"/);
  assert.match(installer, /PluginSha256\s*=\s*"[a-f0-9]{64}"/);
  assert.match(installer, /SpecialFolder\.CommonApplicationData/);
  assert.match(installer, /Verb\s*=\s*"runas"/);
  assert.match(installer, /SHA256\.HashData/);
  assert.match(installer, /SourcePayload/);
  assert.match(installer, /sourceRoot/);
  assert.match(installer, /signalsmith-stretch\.signalsmith-stretch\.h/);
  assert.match(installer, /signalsmith-linear\.fft\.h/);
  assert.match(plugin, /signalsmith::stretch::SignalsmithStretch<float>/);
  assert.match(plugin, /setTransposeSemitones/);
  assert.match(plugin, /kFilterId\[\]\s*=\s*"byeollog_voice_filter_v1"/);
  assert.match(project, /Native\\byeollog-voice-filter\.dll/);
  assert.match(project, /COPYING_GPL-2\.0\.txt/);
  assert.match(project, /Source\.vendor\.signalsmith-stretch/);
  assert.match(project, /Source\.vendor\.signalsmith-linear/);

  const expectedHash = installer.match(/PluginSha256\s*=\s*"([a-f0-9]{64})"/)?.[1];
  assert.ok(expectedHash, "embedded plugin hash constant is required");
  const pluginBytes = await binary("Native/byeollog-voice-filter.dll");
  assert.equal(createHash("sha256").update(pluginBytes).digest("hex"), expectedHash);
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
  assert.match(ui, /id="ensureVoiceFiltersButton"[^>]*>두 필터 자동 준비<\/button>/);
  assert.match(ui, /class="voice-filter-actions"/);
  assert.match(ui, /class="voice-tone-grid"/);
  assert.match(ui, /class="voice-tone-label">다운톤<\/span>/);
  assert.match(ui, /class="voice-tone-label">업톤<\/span>/);
  assert.match(ui, /post\('ensureVoiceAnonymizerFilters'/);
  assert.match(ui, /두 톤 준비됨/);
  assert.match(ui, /id="previewVoiceButton"[^>]*aria-label="다운톤 필터 5초 미리보기"[^>]*>5초 미리보기<\/button>/);
  assert.match(ui, /id="previewVoiceUpButton"[^>]*aria-label="업톤 필터 5초 미리보기"[^>]*>5초 미리보기<\/button>/);
  assert.match(ui, /id="previewVoiceWizardButton"/);
  assert.match(ui, /value="anonymous_low"/);
  assert.match(ui, /value="anonymous_high"/);
  assert.match(ui, /post\('previewVoiceAnonymizer',\{preset/);
  assert.match(ui, /voiceSettingsDirty/);
  assert.match(ui, /localVoiceFilterReady/);
  for (const property of ["preset", "label", "filterName", "ready", "filterEnabled", "state", "message"]) {
    assert.match(
      form,
      new RegExp(`JsonPropertyName\\(\\"${property}\\"\\)`),
      `voice preset UI state must serialize ${property} with the exact camelCase key read by the WebView`
    );
  }
  assert.match(form, /RunLocalVoiceAnonymizerPreviewAsync|PreviewVoiceAnonymizerAsync/);
  assert.match(form, /ObsVoiceAnonymizerProvisioner\.EnsureAsync/);
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
