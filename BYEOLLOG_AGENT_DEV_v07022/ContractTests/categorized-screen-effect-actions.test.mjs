import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const bytes = path => readFile(new URL(path, root));
const text = async path => (await bytes(path)).toString("utf8");

test("action catalog is grouped and camera remains an honest placeholder", async () => {
  const ui = await text("Ui/agent_automation.html");
  for (const label of ["마이크 액션", "화면 액션", "카메라 액션", "이펙트 액션", "룰렛 액션"])
    assert.match(ui, new RegExp(label));
  for (const action of ["화면 뒤집기", "지진이야!", "물벼락", "축포"])
    assert.match(ui, new RegExp(action.replace(/[!]/g, "\\!")));
  assert.match(ui, /카메라 소스를 안전하게 식별하고 복구하는 기반부터 검증하고 있습니다/);
  assert.doesNotMatch(ui, /data-feature="camera-/);
  assert.match(ui, /categorized-action-ui/);
  assert.match(ui, /camera-action-category/);
});

test("screen actions use only OBS scene APIs and guarantee cleanup", async () => {
  const [adapter, obs, agent, capabilities] = await Promise.all([
    text("ScreenActionAdapter.cs"),
    text("ObsWebSocketClient.cs"),
    text("VNextLocalAgent.cs"),
    text("VNextAgentCapabilities.cs")
  ]);
  assert.match(adapter, /internal const string FlipActionType = "obs\.screen_flip_for"/);
  assert.match(adapter, /internal const string ShakeActionType = "obs\.screen_shake_for"/);
  assert.match(adapter, /TemporaryScenePrefix = "별록 화면 액션 "/);
  assert.match(adapter, /scaleY = -1\.0/);
  assert.match(adapter, /RunShakeAsync/);
  assert.match(adapter, /finally[\s\S]*RestoreAndRemoveAsync/);
  assert.match(adapter, /RecoverStaleTemporaryScenesAsync/);
  assert.match(adapter, /SetCurrentProgramSceneAsync\(encoded/);
  assert.match(adapter, /CancellationTokenSource\(TimeSpan\.FromSeconds\(12\)\)/);
  assert.match(adapter, /parameters\.EnumerateObject\(\)\.Count\(\) == 7/);
  assert.match(adapter, /parameters\.EnumerateObject\(\)\.Count\(\) != 8/);
  for (const request of ["GetSceneList", "GetCurrentProgramScene", "GetVideoSettings", "CreateScene", "RemoveScene", "CreateSceneItem", "SetSceneItemTransform", "SetCurrentProgramScene"])
    assert.match(obs, new RegExp(`"${request}"`));
  assert.match(agent, /RequiresGuaranteedRestore[\s\S]*ScreenActionAdapter\.FlipActionType/);
  assert.match(agent, /RecoverStaleAsync/);
  assert.match(capabilities, /"obs\.screen_flip_for"/);
  assert.match(capabilities, /"obs\.screen_shake_for"/);
  assert.doesNotMatch(adapter, /Process\.Start|SendKeys|mouse_event|keybd_event/);
});

test("water and fireworks package immutable transparent assets and synchronized audio", async () => {
  const assets = [
    ["byeollog_water_splash.png", "bb9664f62a75c34cefcf4241e6073a5a5a85708f02da58d05d06cf733c23a384"],
    ["byeollog_fireworks.png", "3fd85cd5305c354b85f1ae2ca46cddf382c9d2922977526489950db259463a94"]
  ];
  const [cache, project, adapter, overlay] = await Promise.all([
    text("OverlayAssetCache.cs"),
    text("HurogiCollector.csproj"),
    text("VisualEffectOverlayActionAdapter.cs"),
    text("ByeollogOverlayService.cs")
  ]);
  for (const [file, sha] of assets) {
    const content = await bytes(`Assets/${file}`);
    assert.equal(content.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(createHash("sha256").update(content).digest("hex"), sha);
    assert.match(cache, new RegExp(sha, "i"));
    assert.match(project, new RegExp(file.replaceAll(".", "\\.")));
  }
  assert.match(adapter, /WaterDurationMs = 3_500/);
  assert.match(adapter, /FireworksDurationMs = 5_000/);
  assert.match(adapter, /ShowObservedAudioTransientAsync/);
  assert.match(adapter, /parameters\.EnumerateObject\(\)\.Count\(\) != 6/);
  assert.match(overlay, /categorized-actions-v1/);
  assert.match(overlay, /#effect-stage\.visible\.water-splash/);
  assert.match(overlay, /#effect-stage\.visible\.fireworks/);
});

test("webview sound previews and v16/v6 client contract are fail closed", async () => {
  const [ui, form, trust, client] = await Promise.all([
    text("Ui/agent_automation.html"),
    text("VNextAutomationSettingsForm.cs"),
    text("WebViewTrustPolicy.cs"),
    text("VNextAutomationClient.cs")
  ]);
  assert.match(ui, /post\('previewVisualActionSound'/);
  assert.match(form, /case "previewVisualActionSound"/);
  assert.match(form, /PreviewVisualActionSoundAsync/);
  assert.match(trust, /"previewVisualActionSound"/);
  assert.match(client, /save_guided_rule_v16/);
  assert.match(client, /dispatch_guided_rule_test_v6/);
  assert.match(client, /RequiredChoice\(payload, "visualVariant"/);
  assert.match(client, /RequiredInt\(payload, "visualVolumePercent"/);
});
