import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (name) => readFile(new URL(name, root), "utf8");

const baseline = JSON.parse(
  await readFile(new URL("fixtures/v0518-compatibility.json", import.meta.url), "utf8")
);

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("v0.5.1.8 executable, namespace, legacy state, and wire identities remain compatible", async () => {
  const [project, paths, storage, login, main, collectorScript] = await Promise.all([
    source("HurogiCollector.csproj"),
    source("AgentDataPaths.cs"),
    source("CollectorStorage.cs"),
    source("CollectorLoginWebForm.cs"),
    source("MainForm.cs"),
    source("CollectorScript.cs")
  ]);

  assert.match(project, new RegExp(`<AssemblyName>${escaped(baseline.assemblyName)}</AssemblyName>`));
  assert.match(project, new RegExp(`<RootNamespace>${escaped(baseline.rootNamespace)}</RootNamespace>`));
  assert.match(paths, new RegExp(`LegacyDirectoryName\\s*=\\s*"${escaped(baseline.stateRoot)}"`));
  assert.match(paths, /CopyDirectoryVerified\(legacy, staging\)/);
  assert.match(storage, /AgentDataPaths\.PrepareDataRoot\(\)\.RootPath/);
  assert.match(storage, new RegExp(`ProductionServerUrl\\s*=\\s*"${escaped(baseline.serverUrl)}"`));
  assert.match(storage, new RegExp(`ProductionServerUrl \\+ "${escaped(baseline.collectorPath)}"`));
  assert.match(login, new RegExp(`"${escaped(baseline.pairPath)}"`));
  assert.match(login, new RegExp(`GetProperty\\("${escaped(baseline.deviceTokenField)}"\\)`));
  assert.match(main, new RegExp(`"${escaped(baseline.logPath)}"`));
  assert.match(main, new RegExp(`source_scope\\s*=\\s*"${escaped(baseline.sourceScope)}"`));
  assert.match(main, /CollectorVersion\s*=\s*BuildInfo\.Version/);
  assert.doesNotMatch(main, /CollectorVersion\s*=\s*BuildInfo\.InformationalVersion/);

  // The session recovery implementation may evolve, but the v0.5.1.8 Weflab
  // request contract and source message envelope must remain compatible.
  assert.match(collectorScript, /type:'alertlist_load'/);
  assert.match(collectorScript, /pagetype:'setup'/);
  assert.match(collectorScript, /pageid:'alertlist'/);
  assert.match(collectorScript, /filter:\{ start:stamp\(from\), end:stamp\(to\), min:'', type:'all', search:'' \}/);
  assert.match(collectorScript, /post\(\{kind:'rows', payload:r\}\)/);
});

test("v0.5.1.8 state filenames and rule directories remain readable in place", async () => {
  const [storage, login, program] = await Promise.all([
    source("CollectorStorage.cs"),
    source("CollectorLoginWebForm.cs"),
    source("Program.cs")
  ]);

  for (const name of baseline.stateFiles.filter((name) => name !== "remembered_login_id.txt")) {
    assert.match(storage, new RegExp(`"${escaped(name)}"`), `missing legacy state file ${name}`);
  }
  assert.match(login, /"remembered_login_id\.txt"/);
  for (const name of baseline.stateDirectories) {
    assert.match(storage, new RegExp(`"${escaped(name)}"`), `missing legacy state directory ${name}`);
  }
  assert.match(storage, /if \(!stored\.StartsWith\("dpapi:"/);
  assert.match(storage, /return stored; \/\/ 레거시 평문 호환/);
  assert.match(storage, /LegacyServerHost/);
  assert.match(program, /CollectorLoginWebForm\(storage, vNextDevClient\)/);
  assert.match(program, /저장된 device_token은 서버 업로드 인증용/);
});

test("new automation remains optional and cannot block the v0.5.1.8 collection path", async () => {
  const [program, main] = await Promise.all([
    source("Program.cs"),
    source("MainForm.cs")
  ]);

  const loginIndex = program.indexOf("new CollectorLoginWebForm(storage, vNextDevClient)");
  const automationClientIndex = program.indexOf("new VNextDevelopmentClient(storage.RootPath)");
  const mainIndex = program.indexOf("new MainForm(storage, programStartedAtLocal, vNextDevClient)");
  assert.ok(automationClientIndex >= 0 && mainIndex > automationClientIndex && loginIndex > mainIndex);
  assert.match(program, /_ = vNextDevClient\.BeginRememberedSessionRestore\(\)/);
  assert.doesNotMatch(program, /await vNextDevClient\.BeginRememberedSessionRestore\(\)/);
  assert.match(main, /기존 별록 수집 기능은 계속 사용할 수 있습니다/);
  assert.match(main, /if \(!_vNextDevClient\.IsSignedIn\)[\s\S]{0,240}return;/);
});

test("one Collector login accepts only a verified same-project automation session", async () => {
  const [login, client, main] = await Promise.all([
    source("CollectorLoginWebForm.cs"),
    source("VNextDevelopmentClient.cs"),
    source("MainForm.cs")
  ]);
  assert.doesNotMatch(login, /SignInWithPasswordAsync\(/);
  assert.match(login, /BeginCollectorPairSessionAdoption/);
  assert.match(login, /automation_capability\s*=\s*VNextDevelopmentClient\.AutomationCapability/);
  assert.match(client, /AutomationCapability\s*=\s*"offsl-session-v1"/);
  assert.match(client, /SupabaseProjectRef\s*=\s*"offslvwaugvjotkywlus"/);
  assert.match(client, /SupabaseUrl\s*=\s*"https:\/\/offslvwaugvjotkywlus\.supabase\.co"/);
  assert.match(client, /\/functions\/v1\/event-runtime-g3a/);
  assert.match(client, /\/functions\/v1\/agent-runtime-g3a/);
  assert.doesNotMatch(client, /\/functions\/v1\/event-runtime"/);
  assert.doesNotMatch(client, /\/functions\/v1\/agent-runtime"/);
  assert.match(login, /기존 수집 모드|기존 수집|v0\.5\.1\.8 수집 로그인을 되돌리지 않습니다/);
  assert.doesNotMatch(client, /SignInWithPasswordAsync|grantType:\s*"password"|CreateAuthRequest\("password"/);
  assert.match(client, /TryGetProperty\("workspace_id"/);
  assert.match(client, /TryGetProperty\("automation_workspace_id"/);
  assert.match(client, /Guid\.TryParseExact/);
  assert.match(client, /legacyWorkspaceValue\.GetString\(\)[\s\S]*automationWorkspaceValue\.GetString\(\)[\s\S]*StringComparison\.Ordinal/);
  assert.match(client, /legacyWorkspaceId != automationWorkspaceId/);
  assert.match(client, /internal string WorkspaceId/);
  assert.doesNotMatch(client, /internal const string WorkspaceId/);
  assert.doesNotMatch(client, /f4a9aa7f-5909-45e6-9975-01eabaf3ddab/);
  assert.match(main, /WorkspaceId:\s*_vNextDevClient\.WorkspaceId/);
  assert.doesNotMatch(main, /VNextDevelopmentClient\.WorkspaceId/);
});

test("Collector pair tokens are never blind-adopted across Supabase projects", async () => {
  const [login, client] = await Promise.all([
    source("CollectorLoginWebForm.cs"),
    source("VNextDevelopmentClient.cs")
  ]);

  const syncStart = client.indexOf("public bool TryAdoptCollectorPairSession(");
  const asyncStart = client.indexOf("public async Task<bool> TryAdoptCollectorPairSessionAsync(");
  const start = Math.max(syncStart, asyncStart);
  if (start === -1) {
    assert.doesNotMatch(
      login,
      /TryAdoptCollectorPairSession/,
      "the login flow cannot call a removed pair-session adoption path"
    );
  } else {
    const end = client.indexOf("public async Task<VNextDevelopmentSendResult> SendEventAsync(", start);
    assert.ok(end > start, "pair-session adoption method must have a bounded source section");
    const adoption = client.slice(start, end);

    assert.match(
      adoption,
      /automation_(?:project_url|project_ref|issuer)/,
      "a pair response must declare which Supabase project issued its automation session"
    );
    assert.match(
      adoption,
      /SupabaseUrl/,
      "the declared automation project must be compared with the Agent's compiled project"
    );
    assert.match(adoption, /SupabaseProjectRef/);
    assert.match(
      adoption,
      /StringComparison\.Ordinal(?:IgnoreCase)?|Uri\./,
      "project identity comparison must be explicit rather than a substring check"
    );

    const projectEvidence = adoption.search(/automation_(?:project_url|project_ref|issuer)/);
    const sessionParse = adoption.indexOf("ParseSession(");
    const jwtIssuer = adoption.indexOf("TryReadExpectedAccessTokenClaims(");
    const authUser = adoption.indexOf("ValidateAuthorizedAutomationIdentityAsync(");
    const publish = adoption.indexOf("PublishSession(");
    const workspaceMutation = adoption.indexOf("_workspaceId =");
    assert.ok(projectEvidence >= 0 && sessionParse > projectEvidence, "project evidence must be checked before parsing tokens");
    assert.ok(jwtIssuer > sessionParse, "JWT issuer must be checked before any session publish");
    assert.ok(authUser > jwtIssuer, "offsl Auth user and membership checks must follow issuer validation");
    assert.ok(publish > authUser, "only a fully validated candidate may be published");
    assert.ok(workspaceMutation === -1 || workspaceMutation > projectEvidence, "a rejected response cannot partially change workspace state");
    assert.match(adoption, /PublishSession\(\s*candidate,\s*rememberSession:\s*true/);
  }

  assert.doesNotMatch(
    login,
    /SignInWithPasswordAsync\(/,
    "Collector credentials must never be replayed into a different automation project"
  );
  assert.doesNotMatch(login, /rememberSession:\s*true|TryRestoreRememberedSessionAsync\(/);
  assert.match(client, /SupabaseUrl \+ "\/auth\/v1\/user"/);
  assert.match(client, /\/rest\/v1\/workspace_members\?select=workspace_id,user_id/);
  assert.match(client, /GetArrayLength\(\) != 1/);
});
