import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("automation settings remain available for local setup before the optional session is ready", async () => {
  const main = await source("MainForm.cs");
  const showStart = main.indexOf("private async Task ShowVNextAutomationSettingsAsync(bool display)");
  const showEnd = main.indexOf("private async Task PushMainStateAsync()", showStart);
  const connectStart = main.indexOf("private async Task<bool> ConnectVNextDevelopmentAsync(bool forcePrompt)");
  const connectEnd = main.indexOf("private async Task RunVNextLocalAgentE2ETestAsync()", connectStart);

  assert.ok(showStart >= 0 && showEnd > showStart, "automation settings open flow is missing");
  assert.ok(connectStart >= 0 && connectEnd > connectStart, "automation connection flow is missing");

  const showFlow = main.slice(showStart, showEnd);
  const connectFlow = main.slice(connectStart, connectEnd);
  assert.doesNotMatch(showFlow, /ConnectVNextDevelopmentAsync/);
  assert.match(showFlow, /form\.Show\(\)/);
  assert.match(showFlow, /form\.Hide\(\)/);
  assert.match(showFlow, /form\.TopLevel\s*=\s*false/);
  assert.match(showFlow, /Controls\.Add\(form\)/);
  assert.match(connectFlow, /if \(forcePrompt\)[\s\S]*MessageBox\.Show\(/);
  assert.match(connectFlow, /WaitForPendingCollectorPairSessionAdoptionAsync/);
  assert.match(connectFlow, /일반 별록 로그인 응답에서 별록 액션 세션을 받지 못했습니다/);
  assert.match(connectFlow, /별도의 개발자 로그인이나 자동 연결 설정은 필요하지 않습니다/);
  assert.match(connectFlow, /진단 ZIP/);
  assert.match(connectFlow, /기존 별록 수집 기능은 계속 사용할 수 있습니다/);
});
