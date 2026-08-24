import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Agent 0.7.0.78 preserves explicit trust boundaries for every embedded WebView", async () => {
  const [main, startup, startupHtml, policy, project] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("StartupLoadingForm.cs", root), "utf8"),
    readFile(new URL("Ui/startup_loading.html", root), "utf8"),
    readFile(new URL("WebViewTrustPolicy.cs", root), "utf8"),
    readFile(new URL("HurogiCollector.csproj", root), "utf8")
  ]);

  assert.match(project, /<Version>0\.7\.0\.78<\/Version>/);
  assert.match(policy, /MaxUiMessageChars = 64 \* 1024/);
  assert.match(policy, /MaxWeflabMessageChars = 4 \* 1024 \* 1024/);
  assert.match(policy, /AllowedUiActions/);
  assert.match(policy, /AllowedWeflabKinds/);
  assert.match(policy, /MaxDepth = 48/);

  assert.match(main, /_ui\.CoreWebView2\.NavigationStarting \+= UiNavigationStarting/);
  assert.match(main, /_ui\.CoreWebView2\.FrameNavigationStarting \+= UiFrameNavigationStarting/);
  assert.match(main, /_ui\.CoreWebView2\.NewWindowRequested \+= UiNewWindowRequested/);
  assert.match(main, /_ui\.CoreWebView2\.PermissionRequested \+= CoreWebView2_PermissionRequested/);
  assert.match(main, /_ui\.CoreWebView2\.DownloadStarting \+= CoreWebView2_DownloadStarting/);
  assert.match(main, /_web\.CoreWebView2\.PermissionRequested \+= CoreWebView2_PermissionRequested/);
  assert.match(main, /_web\.CoreWebView2\.DownloadStarting \+= CoreWebView2_DownloadStarting/);
  assert.match(main, /e\.State = CoreWebView2PermissionState\.Deny/);
  assert.match(main, /e\.Cancel = true/);

  assert.match(startup, /NavigateToString\(ReadStartupHtml\(\)\)/);
  assert.match(startup, /AreDevToolsEnabled = false/);
  assert.match(startup, /AreDefaultContextMenusEnabled = false/);
  assert.match(startup, /AreBrowserAcceleratorKeysEnabled = false/);
  assert.match(startup, /if \(!string\.Equals\(args\.Uri, "about:blank"[\s\S]{0,120}args\.Cancel = true/);
  assert.match(startup, /NewWindowRequested \+= \(_, args\) => args\.Handled = true/);
  assert.match(startup, /if \(!_htmlReady \|\| IsDisposed\) return/);
  assert.doesNotMatch(startupHtml, /https?:\/\//i);
  assert.match(startupHtml, /<img class="official-logo" src="__BYEOLLOG_OFFICIAL_LOGO__" alt="별록">/);
  assert.equal((startupHtml.match(/\bsrc\s*=/gi) ?? []).length, 1);
  assert.doesNotMatch(startupHtml, /<iframe|<object|<embed/i);
});

test("automation WebView allows only its exact top-level document and denies secondary capabilities", async () => {
  const [form, policy] = await Promise.all([
    readFile(new URL("VNextAutomationSettingsForm.cs", root), "utf8"),
    readFile(new URL("WebViewTrustPolicy.cs", root), "utf8")
  ]);

  assert.match(
    policy,
    /AutomationPath = "\/agent_automation\.html"/
  );
  assert.match(policy, /uri\.AbsolutePath,\s*AutomationPath,\s*StringComparison\.Ordinal/);
  const automationPolicy = policy.slice(
    policy.indexOf("internal static bool IsAllowedAutomationNavigation"),
    policy.indexOf("internal static bool IsAllowedUiNavigation")
  );
  assert.doesNotMatch(automationPolicy, /IsBlankNavigation/);
  assert.match(form, /WebViewTrustPolicy\.AutomationHost\}\{WebViewTrustPolicy\.AutomationPath\}/);
  assert.match(form, /core\.NavigationStarting \+= Core_NavigationStarting/);
  assert.match(form, /core\.FrameNavigationStarting \+= Core_FrameNavigationStarting/);
  assert.match(form, /core\.PermissionRequested \+= Core_PermissionRequested/);
  assert.match(form, /core\.DownloadStarting \+= Core_DownloadStarting/);
  assert.match(form, /Core_FrameNavigationStarting[\s\S]*?e\.Cancel = true/);
  assert.match(form, /Core_PermissionRequested[\s\S]*?e\.State = CoreWebView2PermissionState\.Deny/);
  assert.match(form, /Core_PermissionRequested[\s\S]*?e\.SavesInProfile = false/);
  assert.match(form, /Core_PermissionRequested[\s\S]*?e\.Handled = true/);
  assert.match(form, /Core_DownloadStarting[\s\S]*?e\.Cancel = true/);
  for (const handler of [
    "Core_NavigationStarting",
    "Core_FrameNavigationStarting",
    "Core_PermissionRequested",
    "Core_DownloadStarting"
  ]) {
    assert.match(form, new RegExp(`-=${handler}|-= ${handler}`));
  }
});

test("WebView messages fail closed before privileged handling", async () => {
  const [main, policy, tests] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("WebViewTrustPolicy.cs", root), "utf8"),
    readFile(new URL("AgentStoreTests/Program.cs", root), "utf8")
  ]);

  assert.match(main, /TryParseUiMessage\(raw, out var root, out var action, out var reason\)/);
  assert.match(main, /TryParseWeflabMessage\(raw, out var message, out _, out var reason\)/);
  assert.match(policy, /reason = "action_blocked"/);
  assert.match(policy, /reason = "kind_blocked"/);
  assert.match(policy, /reason = "too_large"/);
  assert.match(tests, /oversized UI messages are rejected before JSON parsing/);
  assert.match(tests, /legacy double-encoded Weflab messages remain compatible/);
});

test("URL and account details are not persisted in WebView diagnostics", async () => {
  const [main, policy] = await Promise.all([
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("WebViewTrustPolicy.cs", root), "utf8")
  ]);

  assert.match(policy, /SafeOriginForLog/);
  assert.match(policy, /uri\.IdnHost/);
  assert.doesNotMatch(main, /href=\{href\}/);
  assert.doesNotMatch(main, /idx=\{idx\}/);
  assert.doesNotMatch(main, /navigation (?:blocked|allow)[^\n]*\+ e\.Uri/);
  assert.doesNotMatch(main, /popup (?:blocked|→)[^\n]*\+ url/);
  assert.match(main, /probe logged=\{logged\} loginData=\{hasLoginData\} jquery=\{hasJquery\} origin=\{origin\}/);
});
