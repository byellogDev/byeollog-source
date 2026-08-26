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
  const [adapter, obs, obsAdapter, agent, capabilities] = await Promise.all([
    text("ScreenActionAdapter.cs"),
    text("ObsWebSocketClient.cs"),
    text("ObsActionAdapter.cs"),
    text("VNextLocalAgent.cs"),
    text("VNextAgentCapabilities.cs")
  ]);
  assert.match(adapter, /internal const string FlipActionType = "obs\.screen_flip_for"/);
  assert.match(adapter, /internal const string ShakeActionType = "obs\.screen_shake_for"/);
  assert.match(adapter, /TemporaryScenePrefix = "별록 화면 액션 "/);
  assert.match(adapter, /scaleY = -1\.0/);
  assert.match(adapter, /RunShakeAsync/);
  assert.match(adapter, /PrepareEarthquakeAudioAsync/);
  assert.match(adapter, /WaitForActiveAudioStartedAsync/);
  assert.match(adapter, /ShowObservedAudioTransientAsync[\s\S]*WaitForActiveAudioStartedAsync[\s\S]*SetCurrentProgramSceneAsync\(temporarySceneUuid/);
  assert.match(adapter, /EarthquakeAudioTailMs = 600/);
  assert.match(obsAdapter, /shutdown = false/);
  assert.match(obsAdapter, /restart_when_active = false/);
  assert.match(adapter, /SetCurrentProgramSceneAsync\(temporarySceneUuid[\s\S]*RunShakeAsync/);
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

test("water and party popper package immutable transparent art and CC0 natural audio", async () => {
  const assets = [
    ["byeollog_water_splash.png", "6348579b7f309bb83e06d34d70e6db059f54c5d9824b6a9aaae2e6c4a179ea53"],
    ["byeollog_water_runoff_v2.png", "d059b9e5d45fb638b764ea6c8cb3cb794490edc9c2a9587873fa5e1ec0c802ee"],
    ["byeollog_fireworks.png", "16c9c3a09100a48a3c9818efc91335d109d96ba985709e9b5a6439d3f37a1c57"]
  ];
  const audio = [
    ["byeollog_earthquake_natural.wav", "59630b88ea2d67490e96be7c21748fa1a07181c1c3fc24691a88b5e572b36bee"],
    ["byeollog_water_splash_natural.wav", "5622afc8e00c43413d1c14684ea37cea6b0e7577b9e953273920ef14a389f298"],
    ["byeollog_party_popper_natural.wav", "16f5f25be2dd82f1264cb6094256dc17bf97be10c8b20f3b7765cad00559a2c8"]
  ];
  const motion = [
    "byeollog_water_splash_flip_v4.webm",
    "553531218503cf9d79963944900e82c6184eba87bf7e516e414a231b405f3775"
  ];
  const fireworksMotion = [
    "byeollog_photoreal_confetti_double_v5.webm",
    "bcdcac2dbe0073af9fb7ea0fd59e5c7107fe6a66e32be11eb6260110573f8b9c"
  ];
  const [cache, project, adapter, overlay, factory, notices] = await Promise.all([
    text("OverlayAssetCache.cs"),
    text("HurogiCollector.csproj"),
    text("VisualEffectOverlayActionAdapter.cs"),
    text("ByeollogOverlayService.cs"),
    text("ActionSoundFactory.cs"),
    text("THIRD_PARTY_NOTICES_ACTION_ASSETS.txt")
  ]);
  for (const [file, sha] of assets) {
    const content = await bytes(`Assets/${file}`);
    assert.equal(content.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(content[25], 6, `${file} must retain RGBA alpha`);
    assert.equal(createHash("sha256").update(content).digest("hex"), sha);
    assert.match(cache, new RegExp(sha, "i"));
    assert.match(project, new RegExp(file.replaceAll(".", "\\.")));
  }
  for (const [file, sha] of audio) {
    const content = await bytes(`Assets/${file}`);
    assert.equal(content.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(content.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(createHash("sha256").update(content).digest("hex"), sha);
    assert.match(project, new RegExp(file.replaceAll(".", "\\.")));
    assert.match(factory, new RegExp(file.replaceAll(".", "\\.")));
  }
  const motionBytes = await bytes(`Assets/${motion[0]}`);
  assert.equal(motionBytes.subarray(0, 4).toString("hex"), "1a45dfa3", "water motion must be WebM");
  assert.ok(motionBytes.byteLength < 10 * 1024 * 1024, "water motion must remain below the built-in safety budget");
  assert.equal(createHash("sha256").update(motionBytes).digest("hex"), motion[1]);
  assert.match(cache, new RegExp(motion[1], "i"));
  assert.match(project, /byeollog_water_splash_flip_v4\.webm/);
  const fireworksMotionBytes = await bytes(`Assets/${fireworksMotion[0]}`);
  assert.equal(fireworksMotionBytes.subarray(0, 4).toString("hex"), "1a45dfa3", "bodyless confetti motion must be WebM");
  assert.ok(fireworksMotionBytes.byteLength < 10 * 1024 * 1024, "bodyless confetti motion must remain below the built-in safety budget");
  assert.equal(createHash("sha256").update(fireworksMotionBytes).digest("hex"), fireworksMotion[1]);
  assert.match(cache, new RegExp(fireworksMotion[1], "i"));
  assert.match(project, /byeollog_photoreal_confetti_double_v5\.webm/);
  assert.doesNotMatch(factory, /Math\.Sin|NextNoise|CreateWave/);
  for (const soundId of ["719551", "442773", "458398"])
    assert.match(notices, new RegExp(soundId));
  assert.match(notices, /Creative Commons CC0 1\.0/g);
  assert.match(project, /THIRD_PARTY_NOTICES_ACTION_ASSETS\.txt/);
  assert.match(adapter, /WaterDurationMs = 3_500/);
  assert.match(adapter, /FireworksDurationMs = 5_000/);
  assert.match(adapter, /ShowObservedAudioTransientAsync/);
  assert.match(adapter, /parameters\.EnumerateObject\(\)\.Count\(\) != 6/);
  assert.match(overlay, /categorized-actions-v12/);
  assert.match(overlay, /<video id="water-vfx-video" muted playsinline preload="auto"/);
  assert.match(overlay, /\/overlay\/builtin\/water-splash-v4\.webm/);
  assert.match(overlay, /WaterSplashMotionContentSha256/);
  assert.match(overlay, /"video\/webm"/);
  assert.match(overlay, /waterVfxVideo\.currentTime = 0/);
  assert.match(overlay, /waterVfxVideo\.play\(\)/);
  assert.match(overlay, /waterVfxVideo\.onended = \(\) => effectStage\.classList\.add\('water-complete'\)/);
  assert.match(overlay, /waterVfxVideo\.playbackRate = 0\.7/);
  assert.match(overlay, /#effect-stage\.visible\.water-splash \{ animation:water-splash-show 1750ms/);
  assert.match(overlay, /#effect-stage\.water-splash #effect-asset,[\s\S]*#effect-stage\.water-splash #water-flow-canvas \{ display:none; \}/);
  assert.doesNotMatch(overlay, /streamCount|bezierCurveTo/);
  assert.doesNotMatch(overlay, /water-splash-motion[\s\S]*translateY\(25%\)/);
  assert.match(overlay, /#effect-stage\.visible\.water-splash/);
  assert.match(overlay, /#effect-stage\.visible\.fireworks/);
  assert.match(overlay, /<video id="fireworks-vfx-video" muted playsinline preload="auto"/);
  assert.match(overlay, /\/overlay\/builtin\/photoreal-confetti-double-v5\.webm/);
  assert.match(overlay, /FireworksMotionContentSha256/);
  assert.match(overlay, /startFireworksAnimation\(\)/);
  assert.match(overlay, /fireworksVfxVideo\.currentTime = 0/);
  assert.match(overlay, /fireworksVfxVideo\.play\(\)/);
  assert.match(overlay, /#effect-stage\.fireworks #effect-asset \{ display:none; \}/);
  const inlineScript = overlay.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, "overlay inline script is missing");
  assert.doesNotThrow(() => new Function(inlineScript));
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
