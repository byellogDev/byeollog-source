import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const bytes = path => readFile(new URL(path, root));
const text = async path => (await bytes(path)).toString("utf8");

const assets = [
  ["soft", "byeollog_flashbang_soft.gif", "13a4d0c9f6c23b6e18d47a9ed0d93cdb26ce505888c6d1d8a1ea621578724880"],
  ["standard", "byeollog_flashbang_standard.gif", "ebf7aaa5463f1d2b6102eb0083d8926cd4e189d13fbd29c2a2096abc707d17d6"],
  ["strong", "byeollog_flashbang_strong.gif", "0f2bee8b3b6b6dbf566e218a871b25e70be3e6ba2582336128492b8331bd0cdc"]
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

test("flashbang overlay is fullscreen, recovers for three seconds, and binds Browser Source audio", async () => {
  const [overlay, adapter, localAgent, capabilities] = await Promise.all([
    text("ByeollogOverlayService.cs"),
    text("FlashbangOverlayActionAdapter.cs"),
    text("VNextLocalAgent.cs"),
    text("VNextAgentCapabilities.cs")
  ]);
  assert.match(overlay, /#flashbang-stage \{ position: absolute; inset: 0; width: 100%; height: 100%/);
  assert.match(overlay, /#flashbang-asset \{ display: block; width: 100%; height: 100%; object-fit: cover/);
  assert.match(overlay, /flashbang-soft-recover 3000ms/);
  assert.match(overlay, /flashbang-standard-recover 3000ms/);
  assert.match(overlay, /flashbang-strong-recover 3000ms/);
  assert.match(adapter, /internal const int DurationMs = 3_000/);
  assert.match(adapter, /ShowObservedAudioTransientAsync/);
  assert.match(adapter, /AudioBindingKey = "flashbang-beep-v1"/);
  assert.match(adapter, /beepPlayed/);
  assert.match(localAgent, /FlashbangOverlayActionAdapter\.ActionType/);
  assert.match(capabilities, /"flashbang\.overlay"/);
});
