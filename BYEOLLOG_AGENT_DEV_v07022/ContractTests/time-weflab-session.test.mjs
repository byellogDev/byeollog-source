import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Collector preserves edited start time and restores or visibly recovers the Weflab session", async () => {
  const [main, ui, trust] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("Ui/byeollog_ui.html", root), "utf8"),
    readFile(new URL("WebViewTrustPolicy.cs", root), "utf8"),
  ]);

  assert.match(ui, /addEventListener\('input',syncStartTime\)/);
  assert.match(ui, /addEventListener\('change',syncStartTime\)/);
  assert.match(ui, /post\('startTimeChanged'/);
  assert.match(ui, /document\.activeElement===date\|\|document\.activeElement===time/);
  assert.match(ui, /mainState\.collecting\|\|mainState\.forceStartTime\|\|!editingStart/);
  assert.match(main, /await RestoreWeflabSessionAsync\(\)/);
  assert.match(main, /WebView2Data/);
  assert.match(main, /_web\.Visible = false/);
  assert.match(main, /_web\.Source = new Uri\("https:\/\/weflab\.com\/"\)/);
  assert.match(main, /if \(_weflabConnected == connected\) return;/);
  assert.match(main, /위플랩 로그인 세션이 만료되어 수집이 일시 중지됐습니다/);
  assert.match(main, /ShowBrowser\(\);/);
  assert.match(main, /_weflabReconnectPending && _collecting/);
  assert.match(main, /await InjectCollectorAsync\(\);/);
  assert.match(main, /CollectorScript\.Build\(_storage\.Session\.StartLocal, intervalMs: 2000\)/);
  assert.match(main, /Weflab 재로그인 완료 · 수집 스크립트 자동 재연결/);
  assert.match(trust, /"startTimeChanged"/);
});

test("live automation removes fixed upload and agent-claim waits without hammering Weflab every second", async () => {
  const main = await readFile(new URL("MainForm.cs", root), "utf8");

  assert.match(main, /_vNextDevUploadTimer = new\(\) \{ Interval = 100 \}/);
  assert.match(main, /_ = MirrorVNextDevelopmentAsync\(\);/);
  assert.match(main, /sendResult\.QueuedExecutionCount > 0[\s\S]*?_vNextLocalAgent\?\.Wake\(\)/);
  assert.match(main, /sourceAgeMaxMs=/);
  assert.match(main, /mirrorElapsedMs=/);
  assert.doesNotMatch(main, /intervalMs: 1000/);
});
