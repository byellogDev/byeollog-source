import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Weflab expiry first attempts silent profile recovery and only then asks the user", async () => {
  const [main, ui] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("Ui/byeollog_ui.html", root), "utf8"),
  ]);

  assert.match(main, /_weflabRecoveryGate\.Observe\(WeflabHealthSignal\.ApiFailure\)/);
  assert.match(main, /if \(_weflabLoginNoticeShown\) return/);
  assert.match(main, /TryRecoverWeflabSessionWithoutUserAsync\(detail\)/);
  assert.match(main, /RunWeflabRecoveryAttemptAsync\([\s\S]*?attempt: 1[\s\S]*?restartCollectorWebView: false/);
  assert.match(main, /RunWeflabRecoveryAttemptAsync\([\s\S]*?attempt: 2[\s\S]*?restartCollectorWebView: true/);
  assert.match(main, /_web\.CoreWebView2\.Navigate\("https:\/\/weflab\.com\/"\)/);
  assert.match(main, /RestoreWeflabSessionAsync\(\) =>[\s\S]*?BeginStoredWeflabAuthenticationAsync\("앱 시작"\)/);
  assert.match(main, /BeginStoredWeflabAuthenticationAsync\(\$"자동 복구 \{attempt\}\/2"\)/);

  const recoveryCall = main.indexOf("TryRecoverWeflabSessionWithoutUserAsync(detail)");
  const loginFallback = main.indexOf("위플랩 로그인 세션이 만료되어 수집이 일시 중지됐습니다", recoveryCall);
  assert.ok(recoveryCall >= 0 && loginFallback > recoveryCall,
    "manual login UI must remain a fallback after silent recovery");

  assert.match(ui, /weflabRecovering/);
  assert.match(ui, /자동 확인 중/);
  assert.match(ui, /지금 로그인하기/);
});

test("hard Weflab recovery recreates only the collector WebView and preserves the active session", async () => {
  const main = await readFile(new URL("MainForm.cs", root), "utf8");

  assert.match(main, /ResetCollectorWebViewAfterFailedInitialization\(\)/);
  assert.match(main, /_preserveCollectionDuringCollectorWebInitialization = true/);
  assert.match(main, /if \(!_preserveCollectionDuringCollectorWebInitialization\)[\s\S]*?_collecting = false/);
  assert.match(main, /await StopCollectorScriptAsync\(\)/);
  assert.match(main, /_weflabReconnectPending && _collecting && _storage\.Session\?\.Active == true/);
  assert.match(main, /await InjectCollectorAsync\(\)/);
  assert.doesNotMatch(main, /Process\.Start[\s\S]{0,300}Weflab 자동 복구/);
});

test("Weflab recovery is single-flight, bounded, and cancelled with the window", async () => {
  const main = await readFile(new URL("MainForm.cs", root), "utf8");

  assert.match(main, /if \(_weflabRecoveryInProgress\)[\s\S]*?_weflabRecoverySignal\?\.TrySetResult\(false\)/);
  assert.match(main, /attempt: 1,[\s\S]*?timeout: TimeSpan\.FromSeconds\(30\)/);
  assert.match(main, /attempt: 2,[\s\S]*?timeout: TimeSpan\.FromSeconds\(60\)/);
  assert.match(main, /_weflabRecoveryUserTakeover \|\| !_collecting/);
  assert.match(main, /_weflabRecoverySignal\?\.TrySetResult\(false\);[\s\S]*?ShowBrowser\(\)/);
  assert.match(main, /Task\.WhenAny\(signal\.Task, timeoutTask\)/);
  assert.match(main, /var recovered = completed == signal\.Task && await signal\.Task/);
  assert.match(main, /_weflabRecoveryLifetime\.Cancel\(\)/);
  assert.match(main, /_weflabRecoveryLifetime\.Dispose\(\)/);
});

test("Weflab login candidates cannot mask API failure and only a valid donation response recovers", async () => {
  const [main, collector] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("CollectorScript.cs", root), "utf8"),
  ]);

  assert.match(main, /state == "auth_on"\) HandleWeflabLoginCandidate/);
  assert.match(main, /state is "nologin" or "error"\) HandleWeflabApiFailure/);
  assert.match(main, /HandleWeflabApiSuccess\("후원 API 정상 응답"\)/);
  assert.match(main, /_weflabRecoverySignal\?\.TrySetResult\(true\)/);
  assert.match(collector, /state:'auth_on'/);
  assert.match(collector, /state:'error'/);
  assert.doesNotMatch(collector, /success:function\(r\)\{post\(\{kind:'status',state:'on'/);
});
