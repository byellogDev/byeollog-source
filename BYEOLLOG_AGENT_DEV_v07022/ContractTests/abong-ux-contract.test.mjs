import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("Byeollog Action is a persistent major sidebar destination in one Agent window", async () => {
  const [mainUi, automationUi, main] = await Promise.all([
    source("Ui/byeollog_ui.html"),
    source("Ui/agent_automation.html"),
    source("MainForm.cs")
  ]);

  assert.match(mainUi, /data-screen="rules"[\s\S]{0,180}id="automationNav"/);
  assert.doesNotMatch(mainUi, /settings-switch/);
  assert.match(mainUi, /업보 규칙 설정[\s\S]*별록 액션/);
  assert.match(automationUi, /app-sidebar[\s\S]*업보 규칙 설정[\s\S]*별록 액션/);
  assert.doesNotMatch(mainUi, />방송 자동화</);
  assert.doesNotMatch(automationUi, />방송 자동화</);
  assert.doesNotMatch(automationUi, /context-tabs/);
  assert.match(main, /form\.TopLevel\s*=\s*false/);
  assert.match(main, /Controls\.Add\(form\)/);
  assert.match(main, /form\.Dock\s*=\s*DockStyle\.Fill/);
  assert.match(main, /PreloadVNextAutomationSettingsAsync/);
  assert.match(main, /if \(!openForm\.Visible\) openForm\.Show\(\)/);
  assert.match(main, /AutomationSettingsForm_BackRequested[\s\S]*form\.Hide\(\)/);
  const openStart = main.indexOf("private async Task ShowVNextAutomationSettingsAsync(bool display)");
  const openEnd = main.indexOf("private async Task PushMainStateAsync()", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.doesNotMatch(main.slice(openStart, openEnd), /form\.ShowDialog\(this\)/);
  assert.match(main, /_mainUiWebViewEnvironment\s*=\s*environment/);
  assert.match(main, /return _mainUiWebViewEnvironment/);
  assert.match(main, /HostThemeChangedRequested/);
  assert.match(main, /ApplyHostThemeAsync/);
  assert.match(automationUi, /post\('theme'/);
  assert.match(automationUi, /window\.byeollogAutomation\s*=\s*Object\.freeze\([\s\S]*setTheme/);
});

test("legacy and automation surfaces share one product language and one canonical header", async () => {
  const [mainUi, automationUi] = await Promise.all([
    source("Ui/byeollog_ui.html"),
    source("Ui/agent_automation.html")
  ]);
  for (const ui of [mainUi, automationUi]) {
    assert.match(ui, /<header class="topbar" id="windowDragArea">/);
    assert.match(ui, /BYEOLLOG AGENT/);
    assert.match(ui, /title="화이트 모드로 변경"/);
    assert.match(ui, /title="최소화"/);
    assert.match(ui, /title="닫기"/);
  }
  assert.match(mainUi, /업보 규칙 설정/);
  assert.match(mainUi, /후원 결과에 따라 업보를 자동으로 수집합니다\./);
  assert.match(mainUi, /후원 금액에 따른 예상/);
  assert.match(mainUi, /정해진 후원 금액에/);
  assert.doesNotMatch(mainUi, /후원 규칙 설정/);
});

test("broadcast automation starts from the Abong feature catalog and excludes legacy upbo composition", async () => {
  const automation = await source("Ui/agent_automation.html");

  assert.match(automation, /id="featureCatalog"/);
  assert.match(automation, /id="startAbong"/);
  assert.match(automation, /id="startRewardMultiplier"/);
  assert.match(automation, />아봉</);
  assert.match(automation, /다음 룰렛 보상 증가/);
  assert.match(automation, /openAbongWizard/);
  assert.doesNotMatch(automation, /value="upbo\.apply"/);
  assert.doesNotMatch(automation, /업보 만들기·합치기/);
});

test("Byeollog Action management is full-width and Abong setup is a three-step wizard", async () => {
  const automation = await source("Ui/agent_automation.html");

  assert.match(automation, /id="automationHome"[\s\S]*설정된 별록 액션/);
  assert.match(automation, /id="addFeatureButton"[\s\S]*id="featureCatalogView"/);
  assert.doesNotMatch(automation, /<aside class="list-pane"/);
  assert.equal((automation.match(/data-wizard-step="[123]"/g) ?? []).length, 3);
  assert.match(automation, /id="previousButton"/);
  assert.match(automation, /id="nextButton"/);
  assert.match(automation, /function validateConditionStep\(\)/);
  assert.match(automation, /function validateControlStep\(\)/);
  assert.match(automation, /function goWizardStep\(step\)/);
  assert.match(automation, /builder-pane\.wizard-open/);
  assert.match(automation, /\.composer\{height:100%;min-height:0\}/);
  assert.match(automation, /\.form-footer\{min-height:48px/);
  assert.doesNotMatch(automation, /wizard-step:not\(\[hidden\]\)\{display:flex;min-height:350px/);
});

test("screen connection hides approved-image inventory and selects screens only inside each action setup", async () => {
  const automation = await source("Ui/agent_automation.html");
  const overlayStart = automation.indexOf('id="overlaysView"');
  const overlayEnd = automation.indexOf('id="busyLayer"', overlayStart);
  const overlayView = automation.slice(overlayStart, overlayEnd);

  assert.match(overlayView, /OBS에 연결하는 방법/);
  assert.match(overlayView, /각 액션 설정에서 표시 화면과 위치를 고르세요/);
  assert.match(overlayView, /표시할 화면은 각 액션 설정에서 선택합니다/);
  assert.doesNotMatch(overlayView, /승인된 이미지|승인된 화면|파일 형식|SHA|버전/);
  assert.match(automation, /id="overlayAssetId"/);
  assert.doesNotMatch(automation, /function createAssetCard\(/);
});

test("Abong control uses direct seconds, image preview, and overlays for both microphone modes", async () => {
  const [automation, client, contract, agent] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationClient.cs"),
    source("TimedMuteActionCore.cs"),
    source("VNextLocalAgent.cs")
  ]);

  assert.match(automation, /id="durationSeconds"[^>]+min="1"[^>]+max="240"/);
  assert.match(automation, /class="duration-unit">초</);
  assert.match(automation, /오버레이에 출력할 화면/);
  assert.match(automation, /id="overlayPreviewImage"/);
  assert.match(automation, /if\(!multiplier\)\{renderDevices\(\);renderOverlays\(\);renderDurationChips\(\)\}/);
  assert.match(automation, /const overlayEnabled=elements\.overlayEnabled\.checked/);
  assert.doesNotMatch(automation, /durationSeconds\.readOnly=Boolean/);
  assert.doesNotMatch(client, /actionType != "obs\.mute_for"/);
  assert.match(contract, /TryReadWindowsParameters/);
  assert.match(agent, /VNextActionFreshness\.ValidateAndStrip\(/);
  assert.match(agent, /ExecuteWindowsAsync\(\s*actionParameters,\s*job\.OverlayAsset/);
  for (const label of ["마이크 OFF · 심플 마이크", "마이크 OFF · 신호 패널", "마이크 OFF · 스크린 프린트"]) {
    assert.match(automation, new RegExp(label));
  }
  assert.match(automation, /aspect-ratio:16\/9/);
  assert.match(automation, /overlayPlacementClass/);
  assert.match(automation, /id="overlayScaleRange"[^>]+min="25"[^>]+max="200"/);
  assert.match(automation, /overlayScalePercent/);
});

test("donation automation keeps one exact amount while roulette runs only by result name", async () => {
  const [automation, client, migration] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationClient.cs"),
    source("DatabaseMigrations/20260820_set_donation_exact_amount.sql")
  ]);

  assert.match(automation, /id="amountField" hidden/);
  assert.match(automation, /id="amountLabel"[^>]*>고정 별풍선<\/label>/);
  assert.match(automation, /elements\.amountField\.hidden=roulette/);
  assert.match(automation, /eventType==='donation'\?\(trimmed\(elements\.minAmount\.value\)/);
  assert.match(automation, /eventType==='donation'&&minAmount===null/);
  assert.match(automation, /별풍선이 정확히/);
  assert.match(automation, /conditionValue\(rule,'amount','eq'\)\?\?conditionValue\(rule,'amount','gte'\)/);
  assert.match(client, /eventType == "donation"\s*\? OptionalLong\(payload, "minAmount", "고정 별풍선"/);
  assert.match(client, /eventType == "donation" && minAmount is null/);
  assert.doesNotMatch(automation, /최소 별풍선/);
  assert.doesNotMatch(client, /최소 별풍선/);
  assert.match(migration, /case when p_event_type='donation' then 'eq' else 'gte' end/);
  assert.match(migration, /p_event_type='donation' and p_min_amount is null/);

  const compare = (actual, operator, expected) => operator === "eq"
    ? actual === expected
    : actual >= expected;
  assert.deepEqual([443, 444, 445].map((amount) => compare(amount, "eq", 444)), [false, true, false]);
  assert.deepEqual([443, 444, 445].map((amount) => compare(amount, "gte", 444)), [false, true, true]);
});

test("broadcast readiness keeps developer diagnostics out of the normal user surface", async () => {
  const automation = await source("Ui/agent_automation.html");
  assert.match(automation, /ndev\|vnext\|dev\|sqlite\|database\|schema\|session/);
  assert.match(automation, /현재 필요한 방송 기능이 없어요/);
  assert.match(automation, /OBS 연결/);
  assert.match(automation, /별록 오버레이/);
  assert.match(automation, /const groupedChecks=new Map/);
});

test("v0.7.0.32 preserves rule deletion, split device views, inline URL copy, draggable/scalable overlays, and window controls", async () => {
  const [automation, form, client, policy, migration, deleteMigration, saveMigration, mirrorMigration, ambiguityMigration] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("VNextAutomationClient.cs"),
    source("WebViewTrustPolicy.cs"),
    source("DatabaseMigrations/20260820_add_overlay_scale_distinct_assets_and_safe_save.sql"),
    source("DatabaseMigrations/20260820_add_rule_delete_and_overlay_position.sql"),
    source("DatabaseMigrations/20260820_remove_overlay_approval_and_save_guided_rule_v7.sql"),
    source("DatabaseMigrations/20260820_fix_save_guided_rule_v7_mirror_key.sql"),
    source("supabase/migrations/20260820052623_fix_save_guided_rule_v7_ambiguous_rule_id.sql")
  ]);

  assert.match(automation, /remove\.textContent='삭제'/);
  assert.match(automation, /id="deleteRuleConfirmLayer"/);
  assert.match(automation, /post\('deleteAutomationRule'/);
  assert.match(form, /DeleteRuleAsync/);
  assert.match(client, /delete_guided_rule_v1/);
  assert.match(policy, /"deleteAutomationRule"/);
  assert.match(deleteMigration, /delete_guided_rule_v1_impl/);

  assert.match(automation, /data-view="devices"[^>]*>PC 관리</);
  assert.match(automation, /data-view="microphones"[^>]*>마이크 설정</);
  assert.match(automation, /id="devicesView"[\s\S]*등록 PC 관리/);
  assert.match(automation, /id="microphonesView"[\s\S]*OBS 마이크[\s\S]*Windows 마이크/);
  assert.match(automation, /#devicesView \.device-grid\{flex:1/);

  assert.doesNotMatch(automation, /id="copyOverlayUrlButton"[^>]*>OBS 주소 복사/);
  assert.match(automation, /class="local-url-row"[\s\S]*id="localOverlayUrl"[\s\S]*id="copyOverlayUrlButton"/);
  assert.match(automation, /title="별록 오버레이 URL 복사"/);

  assert.match(automation, /id="positionEditorLayer"/);
  assert.match(automation, /onpointermove/);
  assert.match(automation, /clampPositionToCanvas/);
  assert.match(automation, /overlayPositionX/);
  assert.match(client, /save_guided_rule_v11/);
  assert.match(saveMigration, /save_guided_rule_v7_impl/);
  assert.match(saveMigration, /p_overlay_image_key text/);
  assert.match(saveMigration, /params=public_action\.params \|\| v_params/);
  assert.match(saveMigration, /params=automation_action\.params \|\| v_params/);
  assert.doesNotMatch(saveMigration, /delete\s+from|drop\s+|truncate\s+/i);
  assert.doesNotMatch(saveMigration, /public\.overlay_assets/);
  assert.match(mirrorMigration, /'overlayImageKey',p_overlay_image_key/);
  assert.match(mirrorMigration, /params=\(coalesce\(runtime_action\.params,'\{\}'::jsonb\) - 'overlayAssetKey'\) \|\| v_runtime_params/);
  assert.doesNotMatch(mirrorMigration, /delete\s+from|drop\s+|truncate\s+/i);
  assert.match(ambiguityMigration, /public_condition\.rule_id=v_rule_id/);
  assert.match(ambiguityMigration, /public_action\.rule_id=v_rule_id/);
  assert.match(ambiguityMigration, /runtime_condition\.rule_id=v_rule_id/);
  assert.match(ambiguityMigration, /runtime_action\.rule_id=v_rule_id/);
  assert.match(ambiguityMigration, /p\.proowner = v_owner/);
  assert.match(ambiguityMigration, /p\.proacl is not distinct from v_acl/);
  assert.doesNotMatch(ambiguityMigration, /drop\s+|truncate\s+/i);
  assert.match(migration, /overlayPositionX/);
  assert.match(migration, /overlayScalePercent/);
  assert.doesNotMatch(migration, /drop\s+constraint/i);
  assert.match(automation, /id="emptyAddButton"/);
  assert.match(automation, /elements\.emptyAddButton\.onclick=showFeatureCatalog/);
  for (const action of ["automationWindowDrag", "automationMinimize", "automationClose"]) {
    assert.match(automation, new RegExp(`post\\('${action}'`));
    assert.match(policy, new RegExp(`"${action}"`));
    assert.match(form, new RegExp(`case "${action}"`));
  }
});

test("Byeollog Action provides confirmed real test dispatch and continuous Abong accumulation", async () => {
  const [automation, form, automationClient, agentClient, policy, migration, sessionMigration, timedMute, adapter, overlay, agent] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("VNextAutomationClient.cs"),
    source("VNextDevelopmentClient.cs"),
    source("WebViewTrustPolicy.cs"),
    source("supabase/migrations/20260820034459_add_action_test_dispatch.sql"),
    source("supabase/migrations/20260820044525_enforce_active_manager_session.sql"),
    source("TimedMuteActionCore.cs"),
    source("TimedMuteActionAdapter.cs"),
    source("ByeollogOverlayService.cs"),
    source("VNextLocalAgent.cs")
  ]);

  assert.match(automation, /test\.textContent='테스트 송출'/);
  assert.match(automation, /actions\.append\(manage,test,edit,remove\)/);
  assert.match(automation, /id="testRuleConfirmLayer"/);
  assert.match(automation, /방송 중이라면 시청자에게 그대로 보일 수 있습니다/);
  assert.match(automation, /post\('testAutomationRule'/);
  assert.match(form, /case "testAutomationRule"/);
  assert.match(form, /DispatchAutomationRuleTestAsync/);
  assert.match(automationClient, /\/rest\/v1\/rpc\/dispatch_guided_rule_test_v2/);
  assert.match(agentClient, /Sha256Pattern\.IsMatch\(idempotencyKey\)/);
  assert.match(agentClient, /Guid\.TryParseExact\(executionId, "D"/);
  assert.match(agentClient, /Guid\.TryParseExact\(eventId, "D"/);
  assert.doesNotMatch(agentClient, /idempotencyKey != executionId/);
  assert.match(policy, /"testAutomationRule"/);
  assert.match(migration, /assert_canary_manager_v1/);
  assert.match(migration, /source[\s\S]*'manual_test'/);
  assert.match(migration, /max_attempts[\s\S]*\n\s*1,/);
  assert.doesNotMatch(migration, /drop\s+|truncate\s+/i);

  assert.match(timedMute, /MaximumAccumulatedDurationMs\s*=\s*900_000/);
  assert.match(timedMute, /AddDurationLocked/);
  assert.match(timedMute, /session\.PendingDurationMs \+= durationMs/);
  assert.match(timedMute, /session\.Accepting = false;[\s\S]*TryRestoreAsync/);
  const executionPath = adapter.slice(
    adapter.indexOf("private async Task<VNextAgentOutcome> ExecuteValidatedAsync"),
    adapter.indexOf("private async Task<TimedMuteRunResult> ExecuteMuteAndOverlayAsync"));
  assert.doesNotMatch(executionPath, /RecoverPendingAsync/);
  assert.match(overlay, /AutomationDisplaySession/);
  assert.match(overlay, /session\.HideAtUtc\.Value\.AddMilliseconds\(durationMs\)/);
  assert.match(agent, /MaximumConcurrentExecutions\s*=\s*4/);
  assert.match(agent, /StartTrackedExecution/);
  assert.match(agent, /ExecutionSlotLease/);
  assert.match(agent, /releaseSlotAfterTimedMuteAccepted/);
  assert.match(agent, /if \(IsTimedMuteAction\(job\)\)[\s\S]*await actionTask/);
  assert.match(timedMute, /onAccepted\?\.Invoke\(\)/);
  assert.match(timedMute, /leader\s*\?\s*cancellationToken\.Register/);
  assert.match(sessionMigration, /if v_session_id is null[\s\S]*not public\.g3a_assert_active_auth_session_v1/);
  assert.match(sessionMigration, /raise exception 'active auth session required' using errcode='42501'/);
  assert.doesNotMatch(sessionMigration, /drop\s+|truncate\s+|delete\s+from/i);
  assert.match(agent, /EffectiveActionTimeoutMs/);
  assert.match(agent, /_outboxFlushGate/);
});

test("OBS and Windows microphone setup are inline, local, and password-safe", async () => {
  const [automation, form, policy] = await Promise.all([
    source("Ui/agent_automation.html"),
    source("VNextAutomationSettingsForm.cs"),
    source("WebViewTrustPolicy.cs")
  ]);

  for (const id of ["obsPort", "obsInputName", "obsPassword", "windowsEndpoint", "saveObsButton", "saveWindowsButton"]) {
    assert.match(automation, new RegExp(`id="${id}"`));
  }
  for (const action of ["saveObsSettings", "testObsSettings", "saveWindowsMicSettings", "testWindowsMicSettings", "refreshLocalConnections"]) {
    assert.match(automation, new RegExp(`post\\('${action}'`));
    assert.match(policy, new RegExp(`"${action}"`));
  }
  assert.match(form, /hasPassword\s*=\s*!string\.IsNullOrEmpty\(obs\.Password\)/);
  assert.doesNotMatch(form, /password\s*=\s*obs\.Password/);
  assert.match(form, /CoreAudioCaptureAdapter\.ListActiveEndpoints/);
  for (const guideText of ["OBS WebSocket 연결 방법", "WebSocket 서버 설정", "WebSocket 서버 활성화", "서버 정보 표시", "연결 확인", "OBS 설정 저장"]) {
    assert.match(automation, new RegExp(guideText));
  }
});

test("public tray keeps only essential actions while tester tools remain gated", async () => {
  const main = await source("MainForm.cs");
  assert.match(main, /ToolStripMenuItem\("별록 에이전트 열기"\)/);
  assert.match(main, /ToolStripMenuItem\("별록 계정 연결 해제"\)/);
  assert.match(main, /if \(BuildInfo\.ShowInternalTesterTools\)[\s\S]*_trayMenu\.Items\.Add\(resendItem\)[\s\S]*_trayMenu\.Items\.Add\(diagnosticItem\)/);
  assert.doesNotMatch(main, /_trayMenu\.Items\.Add\(disconnectVNextDevItem\);\s*_trayMenu\.Items\.Add\(resendItem\);/);
  assert.match(main, /별록 계정: \{connection\}/);
  assert.match(main, /별록 액션: \{agent\.State\}/);
});
