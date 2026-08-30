import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("successful Byeollog login starts one silent Weflab collection session", async () => {
  const [program, main] = await Promise.all([
    readFile(new URL("Program.cs", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8")
  ]);

  assert.match(program, /var programStartedAtLocal = DateTime\.Now/);
  assert.match(program, /if \(login\.ShowDialog\(\) != DialogResult\.OK\)[\s\S]*?mainForm\.Show\(\)/);

  const shown = main.slice(main.indexOf("Shown += async"), main.indexOf("internal void UsePrewarmedMainUiEnvironment"));
  assert.match(shown, /await InitWebAsync\(\);\s*await StartCollectionAfterLoginAsync\(\);/);
  assert.doesNotMatch(shown, /await RestoreWeflabSessionAsync\(\);/);

  const autoStart = main.slice(
    main.indexOf("private async Task StartCollectionAfterLoginAsync"),
    main.indexOf("private Task BeginStoredWeflabAuthenticationAsync")
  );
  assert.match(autoStart, /Interlocked\.Exchange\(ref _automaticCollectionStartAttempted, 1\)/);
  assert.match(autoStart, /startLocalOverride: _programStartedAtLocal/);
  assert.match(autoStart, /restoreStoredWeflabSessionSilently: true/);

  const sessionStart = main.slice(
    main.indexOf("private async Task StartBroadcastSessionAsync"),
    main.indexOf("private async Task EndBroadcastSessionAsync")
  );
  assert.match(sessionStart, /if \(_storage\.Session\?\.Active == true\) return;/);
  assert.match(sessionStart, /await BeginStoredWeflabAuthenticationAsync\("별록 로그인 직후 자동 수집"\)/);
  assert.match(sessionStart, /else if \(_web\.Source is null\)\s*await OpenWeflabAsync\(true\);/);
});
