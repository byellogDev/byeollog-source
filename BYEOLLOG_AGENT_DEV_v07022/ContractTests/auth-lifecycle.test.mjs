import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("Agent 0.7.0.2 persists only DPAPI-protected current and pending device secrets", async () => {
  const storage = await source("CollectorStorage.cs");
  assert.match(storage, /VNextAgentCredentialFile/);
  assert.match(storage, /PendingDeviceSecret/);
  assert.match(storage, /ProtectToken\(credentials\.DeviceSecret\)/);
  assert.match(storage, /ProtectToken\(credentials\.PendingDeviceSecret\)/);
  assert.match(storage, /CollectorStateLifecycle\.AtomicWriteText\(_vNextAgentCredentialsPath/);
  assert.match(storage, /CryptographicOperations\.FixedTimeEquals/);
  assert.doesNotMatch(storage, /Log\([^\n]*(?:DeviceSecret|PendingDeviceSecret)/);
});

test("Collector rotation survives response loss and only commits the persisted pending key", async () => {
  const [client, agent, storage] = await Promise.all([
    source("VNextDevelopmentClient.cs"),
    source("VNextLocalAgent.cs"),
    source("CollectorStorage.cs")
  ]);
  assert.match(client, /operation = "rotate_secret"/);
  assert.match(client, /previousValidUntil <= rotatedAt/);
  assert.match(agent, /BeginVNextAgentDeviceSecretRotation/);
  assert.match(agent, /RotateAgentDeviceSecretAsync/);
  assert.match(agent, /RegisterAgentDeviceAsync\([\s\S]*_pendingDeviceSecret[\s\S]*enrollmentToken: null/);
  assert.match(agent, /CommitVNextAgentDeviceSecretRotation/);
  assert.match(agent, /DeviceSecretRotationInterval = TimeSpan\.FromDays\(90\)/);
  assert.match(storage, /expectedPendingSecret/);
  assert.match(storage, /new VNextAgentCredentialSnapshot\([\s\S]*expectedPendingSecret,[\s\S]*null,[\s\S]*secretRevision/);
});

test("fresh PCs register from the one normal offsl login without a developer credential prompt", async () => {
  const [client, agent, storage, main, collectorLogin, publish] = await Promise.all([
    source("VNextDevelopmentClient.cs"),
    source("VNextLocalAgent.cs"),
    source("CollectorStorage.cs"),
    source("MainForm.cs"),
    source("CollectorLoginWebForm.cs"),
    source("02_PUBLISH.cmd")
  ]);
  assert.match(storage, /LoadVNextAgentEnrollmentToken/);
  assert.match(storage, /RandomNumberGenerator\.GetBytes\(32\)/);
  assert.match(storage, /DataProtectionScope\.CurrentUser/);
  assert.match(client, /operation = "register"/);
  assert.match(client, /enrollmentToken = normalizedEnrollment/);
  assert.match(client, /recent_authentication_required/);
  assert.match(agent, /EnsureCurrentDeviceRegisteredAsync/);
  assert.match(agent, /EnsureCurrentDeviceRegisteredAsync[\s\S]*EnsureDeviceRegisteredAsync\(cancellationToken\)[\s\S]*ReportDeviceStatusAsync\(force: true, cancellationToken\)/);
  assert.match(agent, /VNextAgentCapabilities\.ForWindowsAgent\(\)/);
  const capabilities = await source("VNextAgentCapabilities.cs");
  assert.match(capabilities, /"obs\.mute_for"/);
  assert.doesNotMatch(capabilities, /"(?:local\.dev_delay|local\.log|obs\.set_input_mute)"/);
  assert.match(capabilities, /"windows\.mic_mute_for"/);
  assert.match(agent, /RegisterAgentDeviceAsync\([\s\S]*enrollmentToken/);
  assert.match(main, /await _vNextLocalAgent\.EnsureCurrentDeviceRegisteredAsync\(\)/);
  assert.match(collectorLogin, /automation_capability\s*=\s*VNextDevelopmentClient\.AutomationCapability/);
  assert.match(collectorLogin, /BeginCollectorPairSessionAdoption/);
  assert.doesNotMatch(collectorLogin, /SignInWithPasswordAsync\(/);
  assert.doesNotMatch(client, /SignInWithPasswordAsync|CreateAuthRequest\("password"/);
  assert.doesNotMatch(main, /VNextDevelopmentLoginForm/);
  assert.doesNotMatch(publish, /agent-enrollment-token\.txt/i);
  assert.doesNotMatch(client, /service_role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i);
});

test("Collector disconnect revokes only its in-memory automation session and version surfaces are aligned", async () => {
  const [client, buildInfo, project, program, main, publish, build, uiStore, readiness, manifest, testerPackager, completePackager] = await Promise.all([
    source("VNextDevelopmentClient.cs"),
    source("BuildInfo.cs"),
    source("HurogiCollector.csproj"),
    source("Program.cs"),
    source("MainForm.cs"),
    source("02_PUBLISH.cmd"),
    source("00_BUILD_V070_RC2_ONE_CLICK.cmd"),
    source("UiAssetStore.cs"),
    source("Test-TesterEnvironment.ps1"),
    source("New-ReleaseManifest.ps1"),
    source("tools/package-tester-linux.mjs"),
    source("tools/package-complete-release-linux.mjs")
  ]);
  assert.match(client, /\/auth\/v1\/logout\?scope=local/);
  assert.match(buildInfo, /Version\s*=\s*"0\.7\.0\.134"/);
  assert.match(buildInfo, /InformationalVersion\s*=\s*"0\.7\.0\.134"/);
  assert.match(buildInfo, /DisplayVersion\s*=\s*"0\.7\.0\.134"/);
  assert.match(project, /<Version>0\.7\.0\.134<\/Version>/);
  assert.match(project, /<InformationalVersion>0\.7\.0\.134<\/InformationalVersion>/);
  assert.match(program, /CollectorBuildVersion\s*=\s*BuildInfo\.InformationalVersion/);
  assert.match(main, /CollectorVersion\s*=\s*BuildInfo\.Version/);
  assert.match(publish, /byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64\.zip/);
  assert.match(build, /0\.7\.0\.32/);
  assert.match(uiStore, /UiVersion\s*=\s*"v0\.7\.0\.133"/);
  assert.match(readiness, /collectorVersion\s*=\s*"0\.7\.0\.32"/);
  assert.match(manifest, /README_TESTER_v070_RC2_KO\.txt/);
  assert.match(testerPackager, /VERSION\s*=\s*"0\.7\.0\.32"/);
  assert.match(testerPackager, /byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64/);
  assert.match(completePackager, /VERSION_TAG\s*=\s*"v07032"/);
  assert.match(completePackager, /INFORMATIONAL_VERSION\s*=\s*"0\.7\.0-public\.30"/);
  assert.match(completePackager, /BYEOLLOG_AGENT_v07032_AUTO_UPDATE_BOOTSTRAP_COMPLETE_DEVELOPMENT_KIT\.zip/);
  assert.match(main, /GetName\(\)\.Version\?\.ToString\(\) \?\? BuildInfo\.Version/);
});
