import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("retired local raffle TTS has no health row or polling loop", async () => {
  const [ui,main]=await Promise.all([
    readFile(new URL("Ui/byeollog_ui.html", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8")
  ]);
  assert.doesNotMatch(ui, /id="ttsRow"/);
  assert.doesNotMatch(ui, /TTS 서버/);
  assert.doesNotMatch(ui, /ttsRelayChecked/);
  assert.doesNotMatch(main, /TtsRelayHealthUri/);
  assert.doesNotMatch(main, /RefreshTtsRelayHealthAsync/);
  assert.doesNotMatch(main, /_ttsHealthTimer/);
  const start=ui.indexOf('<div class="main-card health">');
  const healthCard=ui.slice(start,ui.indexOf("</section>",start));
  assert.equal((healthCard.match(/class="health-row/g)??[]).length,3);
});
