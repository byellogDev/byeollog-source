import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the main health card exposes the live TTS relay as its fourth status row", async () => {
  const ui = await readFile(new URL("Ui/byeollog_ui.html", root), "utf8");

  assert.match(ui, /id="ttsRow"/);
  assert.match(ui, /<div class="health-name">TTS 서버<\/div>/);
  assert.match(ui, /id="ttsValue">확인 중<\/div>/);
  assert.match(ui, /id="ttsMeta">연결 상태 확인<\/span>/);
  assert.match(ui, /mainState\.ttsRelayChecked===true/);
  assert.match(ui, /mainState\.ttsRelayConnected===true/);
  assert.match(ui, /ttsConnected\?'연결됨':'연결 안 됨'/);
  assert.match(ui, /ttsConnected\?'정상 연결':'예비 음성 사용'/);
  assert.match(ui, /#ttsRow'\)\.classList\.toggle\('issue',ttsChecked&&!ttsConnected\)/);

  const healthCard = ui.slice(ui.indexOf('<div class="main-card health">'), ui.indexOf("</section>", ui.indexOf('<div class="main-card health">')));
  assert.equal((healthCard.match(/class="health-row/g) ?? []).length, 4);
});

test("the Agent polls the fixed relay health path and requires the intended voice service", async () => {
  const main = await readFile(new URL("MainForm.cs", root), "utf8");

  assert.match(main, /https:\/\/byeollog-tts-relay\.byeollog-tts-relay\.workers\.dev\/healthz/);
  assert.match(main, /ExpectedTtsVoiceVersion\s*=\s*"raffle-winner-cosyvoice3-v1"/);
  assert.match(main, /MaxResponseContentBufferSize\s*=\s*16 \* 1024/);
  assert.match(main, /_ttsHealthTimer\s*=\s*new\(\) \{ Interval = 60 \* 1000 \}/);
  assert.match(main, /RefreshTtsRelayHealthAsync/);
  assert.match(main, /_ttsHealthHttp\.GetAsync\(TtsRelayHealthUri\)/);
  assert.match(main, /TryGetProperty\("healthy"/);
  assert.match(main, /TryGetProperty\("version"/);
  assert.match(main, /ttsRelayChecked\s*=\s*_ttsRelayChecked/);
  assert.match(main, /ttsRelayConnected\s*=\s*_ttsRelayConnected/);
  assert.match(main, /_ttsHealthTimer\.Dispose\(\)/);
  assert.match(main, /_ttsHealthHttp\.Dispose\(\)/);
});
