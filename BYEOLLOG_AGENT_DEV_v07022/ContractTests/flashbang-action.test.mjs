import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const bytes = path => readFile(new URL(path, root));
const text = async path => (await bytes(path)).toString("utf8");

const assets = [
  ["soft", "byeollog_flashbang_soft.gif", "68066dc4778d70ef85f9c48639b306353fd3f8bb2959c952157820362b2d3374"],
  ["standard", "byeollog_flashbang_standard.gif", "1933b6cf667ff7b10edf22c056fc757cb38155c27746d92b5d4da3ce24fa3b71"],
  ["strong", "byeollog_flashbang_strong.gif", "e18d5069154cda112af9eba60ec52ea273ee9301252a4cab2e210506fca584b0"]
];

test("flashbang packages three immutable full-HD recovery assets", async () => {
  const [cache, project] = await Promise.all([
    text("OverlayAssetCache.cs"),
    text("HurogiCollector.csproj")
  ]);
  for (const [intensity, file, expectedHash] of assets) {
    const content = await bytes(`Assets/${file}`);
    assert.equal(content.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.equal(createHash("sha256").update(content).digest("hex"), expectedHash);
    assert.match(cache, new RegExp(`flashbang_${intensity}`));
    assert.match(cache, new RegExp(expectedHash, "i"));
    assert.match(project, new RegExp(file.replaceAll(".", "\\.")));
  }
  assert.match(cache, /1_920,\s*1_080/);
});

test("flashbang UI exposes three strengths and keeps settings audio preview local", async () => {
  const [ui, client, form, trust] = await Promise.all([
    text("Ui/agent_automation.html"),
    text("VNextAutomationClient.cs"),
    text("VNextAutomationSettingsForm.cs"),
    text("WebViewTrustPolicy.cs")
  ]);
  assert.match(ui, /<strong>섬광탄!<\/strong>/);
  for (const value of ["soft", "standard", "strong"])
    assert.match(ui, new RegExp(`name="flashbangIntensity" value="${value}"`));
  assert.match(ui, /약하게 · 은은한 회복/);
  assert.match(ui, /보통 · 권장/);
  assert.match(ui, /강하게 · 화면 완전 점유/);
  assert.match(ui, /id="flashbangVolume"[^>]+min="0"[^>]+max="100"/);
  assert.match(ui, /▶ 삐- 소리 듣기/);
  assert.match(ui, /post\('previewFlashbang',\{intensity:flashbangIntensity,volumePercent:flashbangVolumePercent\}\)/);
  assert.match(ui, /1920×1080 화면 전체/);
  assert.match(ui, /const TESTABLE_ACTION_TYPES=new Set\(\[[^\]]*'flashbang\.overlay'[^\]]*\]\)/);
  assert.match(ui, /const canTest=TESTABLE_ACTION_TYPES\.has\(rule\.action\.type\)/);
  assert.match(ui, /openTestRuleConfirm\(rule\)\{[\s\S]*?!TESTABLE_ACTION_TYPES\.has\(rule\.action\.type\)/);
  assert.match(ui, /섬광탄을 실제로 테스트할까요/);
  assert.match(ui, /저장한 섬광 강도와 볼륨으로 5초간 실제 송출/);
  assert.match(client, /save_guided_rule_v12/);
  assert.match(client, /dispatch_guided_rule_test_v3/);
  assert.match(client, /flashbangIntensity/);
  assert.match(client, /flashbangVolumePercent/);
  assert.match(form, /case "previewFlashbang"/);
  assert.match(form, /PreviewFlashbangAsync/);
  assert.match(form, /FlashbangOverlayActionAdapter\.PlayPreviewBeepAsync/);
  assert.doesNotMatch(form, /PreviewFlashbangInObsAsync/);
  assert.match(trust, /"previewFlashbang"/);
});

test("flashbang overlay is fullscreen, fully recovers over five seconds, and binds Browser Source audio", async () => {
  const [overlay, adapter, localAgent, capabilities] = await Promise.all([
    text("ByeollogOverlayService.cs"),
    text("FlashbangOverlayActionAdapter.cs"),
    text("VNextLocalAgent.cs"),
    text("VNextAgentCapabilities.cs")
  ]);
  assert.match(overlay, /#flashbang-stage \{ position: absolute; inset: 0; width: 100%; height: 100%/);
  assert.match(overlay, /#flashbang-asset \{ display: block; width: 100%; height: 100%; object-fit: cover/);
  assert.match(overlay, /flashbang-soft-recover 5000ms/);
  assert.match(overlay, /flashbang-standard-recover 5000ms/);
  assert.match(overlay, /flashbang-strong-recover 5000ms/);
  assert.match(adapter, /internal const int DurationMs = 5_000/);
  assert.match(overlay, /@keyframes flashbang-soft-recover \{[^\n]+100% \{ opacity:0 \} \}/);
  assert.match(overlay, /@keyframes flashbang-standard-recover \{[^\n]+100% \{ opacity:0 \} \}/);
  assert.match(overlay, /@keyframes flashbang-strong-recover \{[^\n]+100% \{ opacity:0 \} \}/);
  assert.match(adapter, /ShowObservedAudioTransientAsync/);
  assert.match(adapter, /AudioBindingKey = "flashbang-blast-v2"/);
  assert.match(adapter, /ringFrequency = 3_560\.0/);
  assert.doesNotMatch(adapter, /1_180\.0 - 120\.0 \* progress/);
  assert.match(adapter, /beepPlayed/);
  assert.match(localAgent, /FlashbangOverlayActionAdapter\.ActionType/);
  assert.match(capabilities, /"flashbang\.overlay"/);
});
