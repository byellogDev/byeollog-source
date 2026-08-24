import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (name) => {
  try {
    return await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Agent product-transition contract requires work/ndev/${name}`);
    }
    throw error;
  }
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const between = (contents, start, end, label) => {
  const from = contents.indexOf(start);
  const to = contents.indexOf(end, from + start.length);
  assert.ok(from >= 0, `${label} start is missing`);
  assert.ok(to > from, `${label} end is missing`);
  return contents.slice(from, to);
};

test("tester-facing app surfaces are branded as 별록 에이전트 / BYEOLLOG AGENT", async () => {
  const [buildInfo, program, main, login, shell, automation, installer, launcher] = await Promise.all([
    source("BuildInfo.cs"),
    source("Program.cs"),
    source("MainForm.cs"),
    source("CollectorLoginWebForm.cs"),
    source("Ui/byeollog_ui.html"),
    source("Ui/agent_automation.html"),
    source("Install-Byeollog.ps1"),
    source("Byeollog-Launcher.ps1")
  ]);

  assert.match(buildInfo, /ProductName\s*=\s*"별록 에이전트"/);
  assert.match(buildInfo, /EnglishProductName\s*=\s*"BYEOLLOG AGENT"/);
  assert.match(shell, /<title>\s*별록 에이전트(?:\s*[·|][^<]*)?<\/title>/);
  assert.match(shell, /BYEOLLOG AGENT/);
  assert.match(automation, /<title>\s*별록 에이전트(?:\s*[·|][^<]*)?<\/title>/);
  assert.match(automation, /BYEOLLOG AGENT/);
  assert.match(main, /Text\s*=\s*\$?"별록 에이전트/);
  assert.match(program, /별록 에이전트가 이미 실행 중입니다/);
  assert.match(login, /BuildInfo\.ProductName/);
  assert.match(installer, /"별록 에이전트\.lnk"/);

  for (const [name, contents] of [
    ["Program.cs", program],
    ["MainForm.cs", main],
    ["CollectorLoginWebForm.cs", login],
    ["Ui/byeollog_ui.html", shell],
    ["Ui/agent_automation.html", automation],
    ["Byeollog-Launcher.ps1", launcher]
  ]) {
    assert.doesNotMatch(contents, /별록 Collector/, `${name} still exposes the retired product name`);
    assert.doesNotMatch(contents, /별록 Agent/, `${name} must use the Korean product name on Korean surfaces`);
  }
  assert.match(installer, /\$legacyShortcutPath\s*=\s*Join-Path \$programs "별록 Collector\.lnk"/);
  assert.match(installer, /Remove-Item\s+-LiteralPath\s+\$legacyShortcutPath/);
});

test("the Agent exposes one unified release label without the historical public-build counter", async () => {
  const [buildInfo, main, ui] = await Promise.all([
    source("BuildInfo.cs"),
    source("MainForm.cs"),
    source("Ui/byeollog_ui.html")
  ]);
  assert.match(buildInfo, /Version\s*=\s*"0\.7\.0\.78"/);
  assert.match(buildInfo, /InformationalVersion\s*=\s*"0\.7\.0\.78"/);
  assert.match(buildInfo, /DisplayVersion\s*=\s*"0\.7\.0\.78"/);
  assert.match(main, /BuildInfo\.DisplayVersion/);
  assert.doesNotMatch(main, /nDev/);
  assert.match(main, /\$"별록 · \{text\.Replace\("상태: ", ""\)\}"/);
  assert.match(main, /releaseLabel\s*=\s*BuildInfo\.DisplayVersion/);
  assert.match(ui, /mainState\.releaseLabel/);
  assert.doesNotMatch(ui, /collectorIdentity[^\n]+DEV/);
  assert.doesNotMatch(buildInfo, /공개판|public\./);
});

test("every normally approved streamer can use the public automation surface", async () => {
  const [access, form, automation, uiStore] = await Promise.all([
    source("VNextActivityClient.cs"),
    source("VNextAutomationSettingsForm.cs"),
    source("Ui/agent_automation.html"),
    source("UiAssetStore.cs")
  ]);

  assert.match(access, /"owner",\s*"admin",\s*"member",\s*"viewer"/);
  assert.match(access, /role is "owner" or "admin"/);
  assert.match(access, /user_id=eq\./);
  assert.match(access, /returnedUserId != authenticatedUserId/);
  assert.doesNotMatch(form, /owner\/admin만/);
  assert.doesNotMatch(automation, /owner\/admin/);
  assert.match(uiStore, /UiVersion\s*=\s*"v0\.7\.0\.78"/);
});

test("legacy Collector shortcut cleanup removes only the installer-owned target", async () => {
  const installer = await source("Install-Byeollog.ps1");
  const helperStart = installer.indexOf("function Test-SameNormalizedWindowsPath");
  const helperEnd = installer.indexOf("function Read-JsonObject", helperStart);
  const cleanupStart = installer.indexOf('$legacyShortcutPath = Join-Path $programs "별록 Collector.lnk"');
  const cleanupEnd = installer.indexOf('Write-Host ""', cleanupStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "normalized Windows path helper is missing");
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "legacy shortcut cleanup block is missing");

  const helper = installer.slice(helperStart, helperEnd);
  const cleanup = installer.slice(cleanupStart, cleanupEnd);
  assert.match(helper, /ExpandEnvironmentVariables/);
  assert.match(helper, /IsPathRooted/);
  assert.match(helper, /GetFullPath/);
  assert.match(helper, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(helper, /catch \{ return \$false \}/);
  assert.match(cleanup, /CreateShortcut\(\$legacyShortcutPath\)/);
  assert.match(cleanup, /Join-Path \$installRoot "LAUNCH_BYEOLLOG\.cmd"/);
  assert.match(cleanup, /Test-SameNormalizedWindowsPath[^\n]+legacyShortcut\.TargetPath/);
  assert.match(cleanup, /portable 또는 다른 설치 대상을 가리켜 보존했습니다/);
  assert.match(cleanup, /안전하게 확인하지 못해 보존했습니다/);
  assert.ok(
    cleanup.indexOf("Test-SameNormalizedWindowsPath") < cleanup.indexOf("Remove-Item -LiteralPath $legacyShortcutPath"),
    "the legacy shortcut must not be removed before its target ownership is confirmed"
  );
});

test("manual package install creates a console-free direct Agent shortcut", async () => {
  const installer = await source("Install-Byeollog.ps1");
  const shortcutStart = installer.indexOf('$shortcutPath = Join-Path $programs "별록 에이전트.lnk"');
  const shortcutEnd = installer.indexOf('$legacyShortcutPath = Join-Path $programs "별록 Collector.lnk"', shortcutStart);
  assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart, "managed shortcut block is missing");

  const shortcut = installer.slice(shortcutStart, shortcutEnd);
  assert.match(shortcut, /\$installedExecutable = Join-Path \$target "byeollog\.exe"/);
  assert.match(shortcut, /\$shortcut\.TargetPath = \$installedExecutable/);
  assert.match(shortcut, /\$shortcut\.WorkingDirectory = \$target/);
  assert.doesNotMatch(shortcut, /LAUNCH_BYEOLLOG|\.cmd/i);
});

test("the Agent uses ByeollogAgent data while preserving executable, wire, install, and single-instance compatibility", async () => {
  const [project, paths, storage, program, uiStore, main, installer, manifest] = await Promise.all([
    source("HurogiCollector.csproj"),
    source("AgentDataPaths.cs"),
    source("CollectorStorage.cs"),
    source("Program.cs"),
    source("UiAssetStore.cs"),
    source("MainForm.cs"),
    source("Install-Byeollog.ps1"),
    source("New-ReleaseManifest.ps1")
  ]);

  assert.match(project, /<AssemblyName>byeollog<\/AssemblyName>/);
  assert.match(project, /<RootNamespace>HurogiCollector<\/RootNamespace>/);
  assert.match(project, /LogicalName="HurogiCollector\.Ui\./);
  assert.match(manifest, /product\s*=\s*"byeollog-collector"/);
  assert.match(manifest, /path\s*=\s*"byeollog\.exe"/);

  assert.match(paths, /CurrentDirectoryName = "ByeollogAgent"/);
  assert.match(paths, /LegacyDirectoryName = "HurogiCollector"/);
  assert.match(paths, /CopyDirectoryVerified\(legacy, staging\)/);
  assert.match(paths, /SHA256\.HashData\(sourceStream\)/);
  assert.match(paths, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(paths, /Directory\.Move\(staging, current\)/);
  assert.match(paths, /LegacyBackupRetained: true/);
  assert.doesNotMatch(paths, /Directory\.Delete\(legacy/);
  assert.match(storage, /AgentDataPaths\.PrepareDataRoot\(\)\.RootPath/);
  assert.match(program, /CollectorStateLifecycle\.Prepare\(\s*dataRootPreparation\.RootPath/);
  assert.match(installer, /Programs\\ByeollogCollector/);
  assert.match(installer, /Join-Path \$env:LOCALAPPDATA "ByeollogAgent"/);
  assert.match(uiStore, /AgentDataPaths\.PrepareDataRoot\(\)\.RootPath/);
  assert.match(main, /Path\.Combine\(_storage\.RootPath, "WebView2Data"\)/);

  assert.match(program, /Local\\ByeollogCollector\.BetaLoginGate\.v0449/);
  assert.match(program, /Local\\ByeollogCollector\.BetaLoginGate\.Activate\.v0449/);
});

test("the pre-version compatibility snapshot includes legacy raw sessions and rules", async () => {
  const [lifecycle, installer] = await Promise.all([
    source("CollectorStateLifecycle.cs"),
    source("Install-Byeollog.ps1")
  ]);
  assert.match(lifecycle, /SnapshotFiles[\s\S]*"donations\.jsonl"/);
  assert.match(lifecycle, /SnapshotDirectories[\s\S]*"sessions"[\s\S]*"session_rules"[\s\S]*"session_fixed_rules"/);
  assert.match(lifecycle, /SHA256\.HashData\(stream\)/);
  assert.doesNotMatch(lifecycle, /File\.ReadAllBytes\(destination\)/);
  assert.match(installer, /entries\.Count -gt 10000/);
  assert.match(installer, /snapshotBytes -gt 4294967296/);
});

test("legacy Collector HTTP and local-agent protocol identifiers remain wire-compatible", async () => {
  const [storage, login, main, development, agentStore] = await Promise.all([
    source("CollectorStorage.cs"),
    source("CollectorLoginWebForm.cs"),
    source("MainForm.cs"),
    source("VNextDevelopmentClient.cs"),
    source("VNextAgentStore.cs")
  ]);

  assert.match(storage, /ProductionServerUrl\s*\+\s*"\/api\/collector"/);
  assert.match(login, /"\/api\/collector-pair"/);
  assert.match(login, /collector_version\s*=\s*BuildInfo\.Version/);
  assert.match(login, /GetProperty\("device_token"\)/);
  assert.match(main, /"\/api\/collector-log"/);
  assert.match(main, /CollectorVersion\s*=\s*BuildInfo\.Version/);
  assert.match(main, /collector_version\s*=\s*CollectorVersion/);
  assert.match(main, /source_scope\s*=\s*"observer-a"/);
  assert.match(main, /Source:\s*"collector"/);

  for (const operation of [
    "register",
    "rotate_secret",
    "overlay_manifest",
    "device_status",
    "claim",
    "heartbeat",
    "ack"
  ]) {
    assert.match(development, new RegExp(`operation\\s*=\\s*"${operation}"`));
  }
  assert.match(agentStore, /execution_target\s+TEXT[^\n]+local_agent/);
});

test("the packaged automation editor reuses the in-memory Agent session", async () => {
  const [project, uiStore, program, main, form] = await Promise.all([
    source("HurogiCollector.csproj"),
    source("UiAssetStore.cs"),
    source("Program.cs"),
    source("MainForm.cs"),
    source("VNextAutomationSettingsForm.cs")
  ]);

  assert.match(project, /EmbeddedResource Include="Ui\\agent_automation\.html"/);
  assert.match(project, /LogicalName="HurogiCollector\.Ui\.agent_automation\.html"/);
  assert.doesNotMatch(project, /vnext_rule_builder\.html/);
  assert.match(uiStore, /HurogiCollector\.Ui\.agent_automation\.html/);
  assert.match(uiStore, /Path\.Combine\(root,\s*"agent_automation\.html"\)/);
  assert.doesNotMatch(uiStore, /vnext_rule_builder\.html/);
  assert.match(form, /VNextDevelopmentClient/);
  assert.match(form, /WebViewTrustPolicy\.AutomationPath/);
  assert.match(form, /LoadAutomationStateAsync/);
  assert.match(form, /SaveAutomationRuleAsync/);
  assert.match(form, /SetAutomationRuleEnabledAsync/);
  assert.doesNotMatch(
    program,
    /new VNextDevelopmentLoginForm\([^)]*\)[\s\S]{0,240}ShowDialog\(\)/,
    "a missing new-feature session must not block legacy Collector startup"
  );
  assert.doesNotMatch(main, /VNextDevelopmentLoginForm|SignInWithPasswordAsync/);
  assert.match(main, /별도의 개발자 로그인이나 자동 연결 설정은 필요하지 않습니다/);
  assert.match(main, /ShowVNextAutomationSettingsAsync\(bool display\)/);
  assert.match(main, /ConnectVNextDevelopmentAsync\(forcePrompt:\s*true\)/);
  assert.match(main, /_vNextLocalAgent\?\.Start\(\)/);
  assert.match(
    main,
    /new VNextAutomationSettingsForm\([^;]*_vNextDevClient[^;]*\)/,
    "the settings window must receive the already authenticated in-memory client"
  );
});

test("automation popup leaves the WebView callback before entering its modal loop", async () => {
  const main = await source("MainForm.cs");
  const dispatch = between(
    main,
    'case "openAutomationSettings":',
    'case "screen":',
    "automation open dispatch"
  );
  const queue = between(
    main,
    'private void QueueVNextAutomationSettingsOpen(string targetView = "rules")',
    "private async Task<CoreWebView2Environment> GetAutomationWebViewEnvironmentAsync()",
    "automation open queue"
  );

  assert.match(dispatch, /QueueVNextAutomationSettingsOpen\(\);/);
  assert.match(dispatch, /return;/);
  assert.doesNotMatch(dispatch, /\bawait\b|ShowDialog\s*\(|ConnectVNextDevelopmentAsync/);
  assert.match(queue, /_automationSettingsOpenOrPending\)\s*return;/);
  assert.match(queue, /BeginInvoke\(new Action\(async \(\) => await ShowVNextAutomationSettingsAsync\(display: true\)\)\)/);
  const newWindowQueue = queue.slice(queue.indexOf("if (_automationSettingsOpenOrPending) return;"));
  assert.ok(
    newWindowQueue.indexOf("_automationSettingsOpenOrPending = true") < newWindowQueue.indexOf("BeginInvoke("),
    "the duplicate-open gate must close before the deferred callback is queued"
  );
  assert.ok(
    newWindowQueue.indexOf("BeginInvoke(") < newWindowQueue.lastIndexOf("_automationSettingsOpenOrPending = false"),
    "a failed UI enqueue must release the duplicate-open gate"
  );
});

test("inline automation teardown drains initialization and bridge handlers before reopening", async () => {
  const [main, form] = await Promise.all([
    source("MainForm.cs"),
    source("VNextAutomationSettingsForm.cs")
  ]);
  const openFlow = between(
    main,
    "private async Task ShowVNextAutomationSettingsAsync(bool display)",
    "private async Task PushMainStateAsync()",
    "automation inline lifetime"
  );
  const shutdown = between(
    form,
    "internal async Task WaitForShutdownAsync()",
    "private bool IsClosing",
    "automation shutdown drain"
  );

  for (const marker of ["form.TopLevel = false", "Controls.Add(form)", "form.Show()", "AutomationSettingsForm_FormClosed", "await form.WaitForShutdownAsync()", "Controls.Remove(form)"]) {
    assert.notEqual(openFlow.indexOf(marker), -1, `automation inline lifetime is missing ${marker}`);
  }
  assert.doesNotMatch(openFlow, /ShowDialog\s*\(/);
  assert.ok(
    openFlow.indexOf("Controls.Add(form)") < openFlow.indexOf("form.Show()") &&
      openFlow.indexOf("await form.WaitForShutdownAsync()") < openFlow.indexOf("Controls.Remove(form)"),
    "the inline surface must attach before show and drain before removal"
  );

  assert.ok(
    shutdown.indexOf("MarkClosing()") < shutdown.indexOf("Task.WhenAll(_initializationTask, messageDrain)") &&
      shutdown.indexOf("Task.WhenAll(_initializationTask, messageDrain)") < shutdown.indexOf("Task.WhenAny(drain"),
    "shutdown must cancel the generation and jointly drain initialization and bridge work"
  );
  assert.match(shutdown, /ShutdownDrainTimeout/);
  assert.match(shutdown, /await drain;/);
  assert.match(form, /Interlocked\.Increment\(ref _activeMessageHandlers\)/);
  assert.match(form, /try \{ await HandleMessageAsync\(e\); \}[\s\S]{0,420}catch \(Exception ex\)[\s\S]{0,900}finally \{ CompleteMessageHandler\(\); \}/);
  assert.match(form, /Automation WebView callback failed[\s\S]{0,240}catch\s*\{[\s\S]{0,160}진단 파일 I\/O 실패/);
  assert.match(form, /finally \{ CompleteMessageHandler\(\); \}/);
  assert.match(form, /case "closeAutomation":[\s\S]{0,500}BackRequested\?\.Invoke\(destination[\s\S]{0,120}return;/);
  assert.doesNotMatch(form, /case "closeAutomation":\s*RequestCloseAfterWebMessage\(\)/);
  assert.match(main, /AutomationSettingsForm_BackRequested[\s\S]{0,900}form\.Hide\(\)/);
  assert.match(form, /BeginInvoke\(new Action\(Close\)\)/);
  assert.match(form, /FormClosing \+= VNextAutomationSettingsForm_FormClosing/);
  assert.doesNotMatch(form, /FormClosed\s*\+=/);
  assert.match(form, /protected override void Dispose\(bool disposing\)[\s\S]*_lifetime\.Dispose\(\)/);
  assert.match(main, /_automationSettingsForm\?\.RequestHostShutdown\(\)/);
});

test("automation popup reuses a retryable environment and treats E_ABORT as close-scoped", async () => {
  const [main, form] = await Promise.all([
    source("MainForm.cs"),
    source("VNextAutomationSettingsForm.cs")
  ]);
  const environmentFactory = between(
    main,
    "private async Task<CoreWebView2Environment> GetAutomationWebViewEnvironmentAsync()",
    "private async Task ShowVNextAutomationSettingsAsync(bool display)",
    "automation environment cache"
  );

  assert.match(main, /CoreWebView2Environment\? _automationWebViewEnvironment/);
  assert.match(main, /Task<CoreWebView2Environment>\? _automationWebViewEnvironmentTask/);
  assert.match(environmentFactory, /CoreWebView2Environment\.CreateAsync\(userDataFolder: userData\)/);
  assert.match(environmentFactory, /_automationWebViewEnvironment\s*=\s*await pending/);
  assert.match(
    environmentFactory,
    /catch\s*\{[\s\S]*ReferenceEquals\(_automationWebViewEnvironmentTask, pending\)[\s\S]*_automationWebViewEnvironmentTask = null;/
  );
  assert.match(main, /new VNextAutomationSettingsForm\([\s\S]*environment\);/);

  assert.match(form, /CoreWebView2Environment environment/);
  assert.match(form, /_environment\s*=\s*environment/);
  assert.match(form, /EnsureCoreWebView2Async\(_environment\)/);
  assert.doesNotMatch(form, /CoreWebView2Environment\.CreateAsync/);
  assert.match(form, /EAbortHResult\s*=\s*unchecked\(\(int\)0x80004004\)/);
  assert.match(
    form,
    /catch \(Exception ex\) when \(IsClosing &&[\s\S]{0,180}ex\.HResult == EAbortHResult/
  );
  assert.match(form, /ex\.HResult == EAbortHResult && IsCurrentGeneration\(generation\)/);
  assert.doesNotMatch(
    form,
    /catch \(Exception ex\) when \(ex\.HResult == EAbortHResult\)\s*\{/,
    "E_ABORT must never be suppressed without a close or current-generation fence"
  );
});

test("agent_automation.html contains no authentication, key, or remote URL surface", async () => {
  const automation = await source("Ui/agent_automation.html");

  for (const forbidden of [
    /https?:\/\//i,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/,
    /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/i,
    /\b(?:projectUrl|publishableKey|accessToken|refreshToken|deviceSecret|collectorToken|serviceRole)\b/,
    /<input\b[^>]*\btype\s*=\s*["'](?:email|url)["']/i,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\b(?:localStorage|sessionStorage)\b/
  ]) {
    assert.doesNotMatch(automation, forbidden);
  }
  assert.match(automation, /id="obsPassword"\s+type="password"/);
  assert.doesNotMatch(automation, /password\s*:\s*obs\.password|obsPassword\.value\s*=/);

  assert.match(automation, /http-equiv=["']Content-Security-Policy["']/i);
  assert.match(automation, /default-src\s+'none'/i);
});

test("the automation WebView bridge is origin-checked, bounded, bidirectional, and action-complete", async () => {
  const [automation, form, policy] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("WebViewTrustPolicy.cs")
  ]);

  assert.match(automation, /window\.chrome\??\.webview\??\.postMessage\s*\(/);
  assert.match(automation, /webview\??\.addEventListener\(\s*["']message["']/);
  assert.match(automation, /window\.byeollogAutomation/);
  for (const method of ["setState", "setBusy", "showToast"]) {
    assert.match(automation, new RegExp(`\\b${method}\\b`));
  }
  assert.match(form, /WebMessageReceived\s*\+=/);
  assert.match(form, /WebMessageAsJson/);
  assert.match(form, /IsTrustedAutomationMessageSource\(e\.Source\)/);
  assert.match(form, /TryParseAutomationMessage\(raw/);
  assert.match(form, /JsonSerializer\.Serialize/);
  assert.match(form, /ExecuteScriptAsync/);
  assert.match(policy, /AutomationHost\s*=\s*"byeollog-agent\.local"/);
  assert.match(policy, /TryCreateHttpsUri\(source/);
  assert.match(policy, /TryParseObject\(raw,\s*MaxUiMessageChars/);
  assert.match(policy, /AllowedAutomationActions\.Contains\(action\)/);
  assert.match(policy, /AutomationActionsRequiringPayload\.Contains\(action\)/);

  const postedActions = new Set([
    ...Array.from(
      automation.matchAll(/\bpost(?:ToHost|Bridge|Message)?\(\s*["']([a-z][A-Za-z0-9]*)["']/g),
      (match) => match[1]
    ),
    ...Array.from(
      automation.matchAll(/\baction\s*:\s*["']([a-z][A-Za-z0-9]*)["']/g),
      (match) => match[1]
    )
  ]);
  assert.ok(postedActions.size >= 3, "automation UI must expose explicit ready/load/save-or-toggle bridge actions");
  for (const action of [
    "automationReady",
    "refreshAutomation",
    "saveAutomationRule",
    "toggleAutomationRule",
    "testAutomationRule",
    "renameAgentDevice",
    "revokeAgentDevice",
    "syncOverlayAssets",
    "previewOverlayAsset",
    "copyOverlayUrl",
    "editAutomationRule",
    "cancelAutomationEdit",
    "closeAutomation"
  ]) {
    assert.ok(postedActions.has(action), `automation UI does not publish ${action}`);
  }
  for (const action of postedActions) {
    assert.match(form, new RegExp(`"${escapeRegExp(action)}"`), `host does not recognize UI action ${action}`);
    assert.match(policy, new RegExp(`"${escapeRegExp(action)}"`), `trust policy does not allow UI action ${action}`);
  }
});

test("native automation requests stay authenticated, workspace-scoped, version-fenced, and typed", async () => {
  const [client, rpcContract] = await Promise.all([
    source("VNextAutomationClient.cs"),
    source("VNextAutomationRpcContract.cs")
  ]);

  for (const endpoint of [
    "/rest/v1/rpc/list_agent_devices_v1",
    "/rest/v1/rpc/rename_agent_device_v1",
    "/rest/v1/rpc/revoke_agent_device_v1",
    "/rest/v1/rpc/save_guided_rule_v13",
    "/rest/v1/rpc/get_raffle_state_v2",
    "/rest/v1/rpc/start_raffle_draw_v2",
    "/rest/v1/rpc/draw_next_raffle_winner_v2",
    "/rest/v1/rpc/reannounce_raffle_winner_v1",
    "/rest/v1/rpc/set_guided_rule_enabled_v1",
    "/rest/v1/rpc/delete_guided_rule_v1",
    "/rest/v1/rpc/dispatch_guided_rule_test_v3"
  ]) {
    assert.match(client, new RegExp(escapeRegExp(endpoint)));
  }
  assert.match(client, /Authorization\s*=\s*new AuthenticationHeaderValue\("Bearer",\s*accessToken\)/);
  assert.match(client, /p_workspace_id\s*=\s*WorkspaceId/);
  assert.match(client, /p_expected_version/);
  assert.match(rpcContract, /p_replace_rule_id/);
  assert.match(client, /VNextAutomationRpcSerializer\.Serialize\(body\)/);
  assert.match(rpcContract, /DefaultIgnoreCondition\s*=\s*JsonIgnoreCondition\.Never/);
  assert.match(rpcContract, /JsonSerializer\.Serialize\(value, Options\)/);
  assert.match(client, /TryGetProperty\("created_enabled"/);
  const rpcArguments = [
    "p_workspace_id", "p_replace_rule_id", "p_expected_version", "p_name",
    "p_enabled", "p_priority", "p_source", "p_event_type", "p_subtype",
    "p_result", "p_min_amount", "p_action_type", "p_event_name",
    "p_output_types", "p_quantity", "p_duration_seconds",
    "p_agent_device_id", "p_overlay_image_key", "p_overlay_position_x",
    "p_overlay_position_y", "p_overlay_scale_percent",
    "p_reward_multiplier", "p_allow_multiplier_stacking"
  ];
  for (const argument of rpcArguments) {
    assert.match(rpcContract, new RegExp(`JsonPropertyName\\(\"${argument}\"\\)`));
  }
  assert.match(client, /"upbo\.apply"/);
  assert.match(client, /"obs\.mute_for"/);
  assert.match(client, /"windows\.mic_mute_for"/);
  assert.match(client, /"roulette\.reward_multiplier_next"/);
  assert.match(client, /MaximumAutomationResponseChars/);
  assert.match(client, /RequireArray\(rules/);
  assert.doesNotMatch(client, /service[_-]?role/i);
});

test("Agent-integrated PC and packaged overlay-image management is fail-closed and exact", async () => {
  const [automation, form, localAgent, overlayService, cache, policy] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("VNextLocalAgent.cs"),
    source("ByeollogOverlayService.cs"),
    source("OverlayAssetCache.cs"),
    source("WebViewTrustPolicy.cs")
  ]);

  for (const label of ["등록 PC 관리", "마이크 설정", "별록 오버레이", "이 PC 보호", "화면 준비", "연결 상태 새로고침"]) {
    assert.match(automation, new RegExp(label));
  }
  assert.match(form, /VNextLocalAgent\? localAgent/);
  assert.match(form, /currentDeviceId\s*=\s*_localAgent\?\.DeviceId/);
  const revoke = between(
    form,
    "private async Task RevokeDeviceAsync(JsonElement payload)",
    "private async Task SyncOverlayAssetsAsync()",
    "native device-revoke boundary"
  );
  assert.match(revoke, /string\.Equals\(deviceId, _localAgent\.DeviceId, StringComparison\.OrdinalIgnoreCase\)/);
  assert.ok(
    revoke.indexOf("string.Equals(deviceId, _localAgent.DeviceId") < revoke.indexOf("_client.RevokeAgentDeviceAsync"),
    "a forged current-PC revoke must be rejected before the network call"
  );
  assert.match(automation, /device\.id===state\.currentDeviceId/);
  assert.match(automation, /revoke\.disabled=state\.busy\|\|!state\.canManage\|\|revoked\|\|current/);

  const exact = between(
    automation,
    "function readyForOverlay(deviceId,imageKey)",
    "function localReadyForOverlay(assetId)",
    "exact overlay readiness"
  );
  assert.match(exact, /item\.key===imageKey/);
  assert.match(exact, /parts\[3\]>=19/);
  assert.doesNotMatch(exact, /approved|assetReadiness/);
  const localExact = between(
    automation,
    "function localReadyForOverlay(assetId)",
    "function deviceSupports(action)",
    "local exact overlay readiness"
  );
  assert.match(localExact, /item\?\.assetId/);
  assert.match(localExact, /item\?\.contentSha256/);
  assert.match(localExact, /===asset\.hash/);
  assert.match(automation, /previewAssetButton\.disabled=true/, "inventory preview stays unavailable outside Abong setup");
  assert.match(
    automation,
    /copyOverlayUrlButton\.disabled=state\.busy\|\|!state\.canManage\|\|!local\.available\|\|local\.overlayRunning!==true/
  );
  assert.match(form, /SyncOverlayAssetsNowAsync\(_lifetimeToken\)/);
  assert.match(
    form,
    /PreviewOverlayAssetAsync\(\s*assetId,\s*asset\.ContentSha256,\s*3_000,\s*_lifetimeToken\)/
  );
  assert.match(cache, /TryResolveByAssetId\(\s*string assetId,\s*string expectedContentSha256/);
  assert.doesNotMatch(cache, /TryResolveByAssetId\(\s*string assetId,\s*out VNextOverlayAssetDescriptor/);
  const sameContent = between(
    cache,
    "private static bool SameContent",
    "private static bool SameRevision",
    "embedded overlay identity comparison"
  );
  assert.match(sameContent, /left\.AssetId\.Equals\(right\.AssetId, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(form, /readyAssets\s*=\s*overlay\.ReadyRevisions\.Select/);

  assert.match(overlayService, /PreviewAsync/);
  assert.match(overlayService, /_automationDisplays\+\+/);
  assert.match(overlayService, /_previewCancellation\?\.Cancel\(\)/);
  assert.match(overlayService, /_displayGate\.WaitAsync\(0, preview\.Token\)/);
  assert.ok(
    overlayService.indexOf("preview.Token.ThrowIfCancellationRequested()") <
      overlayService.indexOf("SetActive(content", overlayService.indexOf("public async Task<bool> PreviewAsync")),
    "a preview canceled immediately after gate acquisition must not reactivate the overlay"
  );
  assert.match(overlayService, /실제 자동화가 시작되면 미리보기를 즉시 양보/);
  assert.match(localAgent, /_overlay\.PreviewAsync/);

  const actualDisplay = between(
    overlayService,
    "public async Task ShowAsync(",
    "public async Task<bool> PreviewAsync(",
    "actual overlay activation"
  );
  assert.match(actualDisplay, /var content = _assetCache\.Read\(resolvedAsset\)/);
  assert.ok(
    actualDisplay.indexOf("_assetCache.Read(resolvedAsset)") < actualDisplay.indexOf("SetActive(content"),
    "actual automation must exact-verify bytes immediately before activation"
  );
  const previewDisplay = between(
    overlayService,
    "public async Task<bool> PreviewAsync(",
    "public ByeollogOverlaySnapshot Snapshot()",
    "preview overlay activation"
  );
  assert.match(previewDisplay, /var content = _assetCache\.Read\(resolvedAsset\)/);
  assert.ok(
    previewDisplay.indexOf("_assetCache.Read(resolvedAsset)") < previewDisplay.indexOf("SetActive(content"),
    "preview must exact-verify bytes immediately before activation"
  );
  assert.match(overlayService, /OverlayAssetContent\? _activeContent/);
  assert.match(overlayService, /ActiveContentForToken/);
  assert.match(overlayService, /TryExactAssetBindingFromTarget/);
  assert.match(
    overlayService,
    /_activeContent\.Descriptor\.ContentSha256,\s*revision,\s*StringComparison\.Ordinal/
  );
  assert.doesNotMatch(overlayService, /_assetCache\.Read\(activeAsset\)/);

  const displayRead = between(
    cache,
    "public OverlayAssetContent Read(",
    "public bool RequiredReady()",
    "display-time cache verification"
  );
  assert.match(displayRead, /OverlayAssetValidator\.VerifyBytes\(builtIn\.Bytes, descriptor\)/);
  assert.match(displayRead, /OverlayAssetValidator\.VerifyBytes\(bytes, descriptor\)/);
  assert.match(displayRead, /_entries\.Remove\(descriptor\.AssetId\)/);
  assert.match(displayRead, /current\.VerifiedAt == entry\.VerifiedAt/);
  assert.match(displayRead, /atomic replace/);

  for (const action of [
    "renameAgentDevice",
    "revokeAgentDevice",
    "syncOverlayAssets",
    "previewOverlayAsset",
    "copyOverlayUrl"
  ]) {
    assert.match(policy, new RegExp(`"${action}"`));
    assert.match(form, new RegExp(`case "${action}"`));
  }
  assert.match(policy, /AutomationActionsRequiringEmptyPayload/);
  assert.match(policy, /payload\.EnumerateObject\(\)\.Any\(\)/);
  assert.doesNotMatch(automation, /publishOverlayAsset|overlay-asset-admin|service[_-]?role/i);
});

test("native PC mutations are fenced by the last strict device snapshot before any RPC", async () => {
  const [form, client] = await Promise.all([
    source("VNextAutomationSettingsForm.cs"),
    source("VNextAutomationClient.cs")
  ]);

  assert.match(client, /ParseAgentDevices\(devices\)/);
  assert.match(form, /IReadOnlyDictionary<string,\s*VNextAutomationDeviceView>\s+_loadedDeviceSnapshot/);
  assert.match(
    form,
    /IReadOnlyList<VNextAutomationDeviceView>\s+devices\s*=\s*management\?\.AgentDevices\s*\?\?\s*Array\.Empty<VNextAutomationDeviceView>\(\)/,
    "the strict snapshot must derive only from the permission-gated management response"
  );
  assert.match(
    form,
    /_loadedDeviceSnapshot\s*=\s*devices\.ToDictionary\([\s\S]*?StringComparer\.OrdinalIgnoreCase\)/
  );

  const guard = between(
    form,
    "private VNextAutomationDeviceView RequireMutableDeviceSnapshot(",
    "private void RequireCanManage()",
    "native loaded-device snapshot guard"
  );
  assert.match(guard, /_loadedDeviceSnapshot\.TryGetValue\(deviceId,\s*out var device\)/);
  assert.match(guard, /device\.ManagementRevision\s*!=\s*expectedRevision/);
  assert.match(guard, /device\.RevokedAt\.HasValue/);
  assert.match(guard, /device\.ConnectionState,\s*"revoked"/);
  for (const code of ["device_not_loaded", "stale_device_snapshot", "device_already_revoked"]) {
    assert.match(guard, new RegExp(`code:\\s*"${code}"`));
  }
  assert.ok(
    guard.indexOf("device.RevokedAt.HasValue") < guard.indexOf("device.ManagementRevision != expectedRevision"),
    "an already-revoked device must get the revoked result before stale-revision UX"
  );

  const rename = between(
    form,
    "private async Task RenameDeviceAsync(JsonElement payload)",
    "private async Task RevokeDeviceAsync(JsonElement payload)",
    "native device rename boundary"
  );
  assert.ok(
    rename.indexOf("RequireMutableDeviceSnapshot(deviceId, expectedRevision)")
      < rename.indexOf("_client.RenameAgentDeviceAsync"),
    "a forged unknown, stale, or revoked rename must be rejected before the RPC"
  );

  const revoke = between(
    form,
    "private async Task RevokeDeviceAsync(JsonElement payload)",
    "private async Task SyncOverlayAssetsAsync()",
    "native device revoke boundary"
  );
  const selfFence = revoke.indexOf("string.Equals(deviceId, _localAgent.DeviceId");
  const snapshotFence = revoke.indexOf("RequireMutableDeviceSnapshot(deviceId, expectedRevision)");
  const rpc = revoke.indexOf("_client.RevokeAgentDeviceAsync");
  assert.ok(selfFence >= 0 && selfFence < snapshotFence && snapshotFence < rpc,
    "current-PC, membership, revision, and revoked fences must all run before the revoke RPC");

  const expired = between(
    form,
    "private async Task SetSessionExpiredAsync(long expectedEpoch)",
    "private Task ShowToastAsync(",
    "expired device snapshot cleanup"
  );
  assert.match(expired, /_loadedDeviceSnapshot\s*=/);
  assert.ok(expired.indexOf("_loadedDeviceSnapshot") < expired.indexOf("ExecuteAsync("));
});

test("device mutation receipts require one exact typed row for the requested device", async () => {
  const client = await source("VNextAutomationClient.cs");
  const rename = between(
    client,
    "public async Task<VNextAgentDeviceRenameReceipt> RenameAgentDeviceAsync(",
    "public async Task<VNextAgentDeviceRevokeReceipt> RevokeAgentDeviceAsync(",
    "rename receipt"
  );
  const revoke = between(
    client,
    "public async Task<VNextAgentDeviceRevokeReceipt> RevokeAgentDeviceAsync(",
    "private async Task<JsonElement> SendAutomationRequestAsync(",
    "revoke receipt"
  );
  const exactlyOne = between(
    client,
    "private static JsonElement ExactlyOneObject(",
    "private static void RequireArray(",
    "exactly-one response helper"
  );
  const responseGuid = between(
    client,
    "private static string RequireResponseGuidString(",
    "private static long RequireLong(",
    "required response device ID helper"
  );
  const timestamp = between(
    client,
    "private static DateTimeOffset RequireResponseTimestamp(",
    "private static string[] StringArray(",
    "required response timestamp helper"
  );

  assert.match(exactlyOne, /value\.ValueKind != JsonValueKind\.Array/);
  assert.match(exactlyOne, /value\.GetArrayLength\(\) != 1/);
  assert.match(exactlyOne, /value\[0\]\.ValueKind != JsonValueKind\.Object/);
  assert.match(responseGuid, /payload\.TryGetProperty\(property, out var value\)/);
  assert.match(responseGuid, /value\.ValueKind != JsonValueKind\.String/);
  assert.match(responseGuid, /Guid\.TryParseExact\(value\.GetString\(\)\?\.Trim\(\), "D", out var parsed\)/);
  for (const mutation of [rename, revoke]) {
    assert.match(mutation, /ExactlyOneObject\(result/);
    assert.match(mutation, /RequireResponseGuidString\(receipt, "device_id"/);
    assert.match(
      mutation,
      /string\.Equals\(returnedDeviceId, normalizedDeviceId, StringComparison\.Ordinal\)/
    );
  }
  assert.match(revoke, /RequireResponseTimestamp\(receipt, "revoked_at", "등록 PC 해제"\)/);
  assert.match(timestamp, /payload\.TryGetProperty\(property, out var value\)/);
  assert.match(timestamp, /value\.ValueKind != JsonValueKind\.String/);
  assert.match(timestamp, /DateTimeOffset\.TryParse\(value\.GetString\(\), out var timestamp\)/);
});

test("automation data is rendered as text and the legacy collection and rule entry points stay intact", async () => {
  const [automation, shell, policy, main] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("Ui/byeollog_ui.html"),
    source("WebViewTrustPolicy.cs"),
    source("MainForm.cs")
  ]);

  assert.match(automation, /\.textContent\s*=/);
  assert.match(automation, /(?:document\.createElement|\.replaceChildren)\s*\(/);
  assert.doesNotMatch(automation, /\.innerHTML\s*=/);
  assert.doesNotMatch(automation, /\.outerHTML\s*=/);
  assert.doesNotMatch(automation, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(automation, /document\.write\s*\(/);

  for (const label of ["수집 목록 보기", "룰렛", "확정"]) {
    assert.match(shell, new RegExp(label));
  }
  assert.match(shell, /data-open=["']collection["']/);
  assert.match(shell, /data-open=["']rules["']/);
  assert.match(shell, /data-screen=["']collection["']/);
  assert.match(shell, /data-screen=["']rules["']/);
  assert.match(shell, /<section\b[^>]*\bid=["']collection["']/);
  assert.match(shell, /<section\b[^>]*\bid=["']rules["']/);
  for (const action of [
    "refreshCollection",
    "upsertRoulette",
    "deleteRoulette",
    "upsertFixed",
    "deleteFixed",
    "saveRules",
    "openAutomationSettings"
  ]) {
    assert.match(shell, new RegExp(`post\\(["']${action}["']`));
    assert.match(policy, new RegExp(`"${action}"`));
    assert.match(main, new RegExp(`case "${action}"`));
  }
});
