import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

function section(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing section: ${startMarker}`);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  assert.ok(end > start, `invalid section order: ${startMarker}`);
  return contents.slice(start, end);
}

function assertOrdered(contents, markers, label) {
  let cursor = -1;
  for (const marker of markers) {
    const next = contents.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ${marker}`);
    assert.ok(next > cursor, `${label}: out of order ${marker}`);
    cursor = next;
  }
}

test("general distribution uses only ephemeral automation sessions and deletes every legacy auto-connect vault", async () => {
  const [vault, client, project, program, login] = await Promise.all([
    source("VNextSessionVault.cs"),
    source("VNextDevelopmentClient.cs"),
    source("HurogiCollector.csproj"),
    source("Program.cs"),
    source("CollectorLoginWebForm.cs")
  ]);

  assert.match(project, /System\.Security\.Cryptography\.ProtectedData/);
  assert.doesNotMatch(vault, /ProtectedData|DataProtectionScope|TryRead\(|public void Save\(|CompleteRememberedSignIn/);

  assert.match(program, /vNextDevClient\.DisableRememberedSessionPersistence\(\)/);
  assert.doesNotMatch(program, /TryRestoreSessionAsync\(/);
  assert.doesNotMatch(client, /TryRestoreSessionAsync\(/);
  assert.doesNotMatch(client, /SignInWithPasswordAsync|CreateAuthRequest\("password"/);
  assert.match(client, /public void DisableRememberedSessionPersistence\(\)[\s\S]{0,180}_sessionVault\.SuppressRestoreAndDelete\(\)/);
  assert.match(login, /automation_capability\s*=\s*VNextDevelopmentClient\.AutomationCapability/);
  assert.match(login, /BeginCollectorPairSessionAdoption/);
  assert.doesNotMatch(login, /SignInWithPasswordAsync|TryRestoreSessionAsync/);

  const persistedLeafNames = [...vault.matchAll(/Path\.Combine\(_directory,\s*"([^"]+)"\)/g)]
    .map((match) => match[1]).sort();
  assert.deepEqual(
    persistedLeafNames,
    ["disconnect.v1", "refresh-token.v1.dpapi"],
    "the vault may persist only a refresh-token blob and disconnect tombstone"
  );

  const publish = section(client, "private void PublishSession(", "private static VNextDevelopmentException BuildAuthException");
  assertOrdered(publish, [
    "if (rememberSession)",
    "remembered_session_disabled",
    "_sessionVault.SuppressRestoreAndDelete()",
    "_accessToken = candidate.AccessToken",
    "_refreshToken = candidate.RefreshToken",
    "Interlocked.Increment(ref _sessionEpoch)"
  ], "publish only after persistence has been rejected and stale vaults are removed");
  assert.doesNotMatch(publish, /_sessionVault\.Save\(|rememberSession:\s*true/);
});

test("explicit disconnect writes the tombstone before best-effort vault deletion and remote logout", async () => {
  const [vault, client] = await Promise.all([
    source("VNextSessionVault.cs"),
    source("VNextDevelopmentClient.cs")
  ]);

  assert.match(
    section(vault, "public void MarkDisconnectedAndDelete()", "public void SuppressRestoreAndDelete()"),
    /SuppressRestoreAndDelete\(\)/
  );
  const disconnectStorage = section(vault, "public void SuppressRestoreAndDelete()", "public void DeleteInvalidVault()");
  assertOrdered(disconnectStorage, [
    "Directory.CreateDirectory(_directory)",
    "File.WriteAllText(_tombstonePath",
    "File.Exists(_vaultPath)",
    "File.Delete(_vaultPath)"
  ], "disconnect tombstone must precede delete");
  assert.match(disconnectStorage, /tombstone intentionally remains authoritative if deletion fails/);

  const disconnect = section(client, "public async Task DisconnectAsync(", "[Obsolete(");
  assertOrdered(disconnect, [
    "var requestLease = CaptureSessionRequestLease(token)",
    "_sessionVault.MarkDisconnectedAndDelete()",
    "InvalidateSessionIfCurrentUnderGate(requestLease)",
    "/auth/v1/logout?scope=local"
  ], "local disconnect must be authoritative before the network request");
});

test("late auth failures can invalidate only the session epoch that issued the request", async () => {
  const [client, program] = await Promise.all([
    source("VNextDevelopmentClient.cs"),
    source("Program.cs")
  ]);

  assert.match(
    client,
    /SessionRequestLease\(long ConnectionEpoch, long TokenRevision, bool MatchedToken\)/,
    "an auth request lease must bind both connection epoch and rotating token revision"
  );
  const asyncInvalidate = section(
    client,
    "private async Task InvalidateSessionIfCurrentAsync(",
    "private void InvalidateSessionIfCurrentUnderGate(");
  assertOrdered(asyncInvalidate, [
    "await _sessionGate.WaitAsync()",
    "InvalidateSessionIfCurrentUnderGate(lease)",
    "_sessionGate.Release()"
  ], "auth failure must reacquire the session gate before invalidation");

  const invalidate = section(client, "private void InvalidateSessionIfCurrentUnderGate(", "private void RaiseSessionChanged()");
  assertOrdered(invalidate, [
    "if (!lease.MatchedToken",
    "SessionEpoch != lease.ConnectionEpoch",
    "Interlocked.Read(ref _tokenRevision) != lease.TokenRevision",
    "return;",
    "_accessToken = \"\"",
    "_refreshToken = \"\"",
    "Interlocked.Increment(ref _tokenRevision)",
    "Interlocked.Increment(ref _sessionEpoch)",
    "RaiseSessionChanged()"
  ], "epoch, token revision, and token ownership conditional invalidation");

  assert.doesNotMatch(client, /TryRestoreSessionAsync\(|rememberSession:\s*true/);

  const send = section(client, "public async Task<VNextDevelopmentSendResult> SendEventAsync(", "private static VNextDevelopmentSendResult ParseSendResult(");
  assertOrdered(send, [
    "var requestLease = CaptureSessionRequestLease(accessToken)",
    "await _http.SendAsync",
    "await InvalidateSessionIfCurrentAsync(requestLease)"
  ], "late send failure invalidation lease");
  assert.match(client, /InvalidateSessionIfCurrentUnderGate\(\s*new SessionRequestLease\(refreshEpoch, refreshRevision, true\)\)/);
  assert.match(program, /vNextDevClient\.ShutdownAsync\(\)\.Wait\(TimeSpan\.FromSeconds\(3\)\)/);
  assert.doesNotMatch(program, /vNextDevClient\.(?:SignOutAsync|DisconnectAsync)\(\)/);
});

test("session changes close stale management UI and cancel already-claimed local actions", async () => {
  const [form, agent, client] = await Promise.all([
    source("VNextAutomationSettingsForm.cs"),
    source("VNextLocalAgent.cs"),
    source("VNextDevelopmentClient.cs")
  ]);

  assert.match(form, /_openedSessionEpoch = _client\.CaptureSessionEpoch\(\)/);
  assert.match(form, /_client\.SessionChanged \+= Client_SessionChanged/);
  const formChanged = section(
    form,
    "private void Client_SessionChanged(",
    "private void MarkClosing()");
  assertOrdered(formChanged, [
    "_client.SessionEpoch == _openedSessionEpoch",
    "BeginInvoke",
    "Close()"
  ], "an open WebView must not survive its issuing session epoch");
  assert.match(form, /_client\.SessionChanged -= Client_SessionChanged/);
  const handle = section(form, "private async Task HandleMessageAsync(", "private async Task LoadAndPushStateAsync(");
  assert.match(handle, /_client\.IsSessionEpochCurrent\(_openedSessionEpoch\)/);
  const canManage = section(form, "private void RequireCanManage()", "private bool IsBusy");
  assert.match(canManage, /_canManage && _client\.IsSessionEpochCurrent\(_openedSessionEpoch\)/);

  assert.match(agent, /_client\.SessionChanged \+= Client_SessionChanged/);
  const process = section(agent, "private async Task ProcessJobAsync(", "private async Task<(bool Uncertain");
  assertOrdered(process, [
    "_store.MarkExecuting(job.ExecutionId, job.AttemptNo)",
    "_client.TryStartSessionOperation(",
    "token => ExecuteWithLeaseAsync(job, token, releaseSlotAfterTimedMuteAccepted)",
    "out CancellationTokenSource? sessionAction",
    "out Task<(bool Uncertain, VNextAgentOutcome? Outcome, string Error)>? executionTask"
  ], "session transition and local side-effect start must be serialized");
  assert.match(process, /catch \(OperationCanceledException\) when \(!cancellationToken\.IsCancellationRequested\)/);
  assert.match(process, /_store\.MarkUncertain[\s\S]*세션 변경/);

  const begin = section(client, "internal bool TryStartSessionOperation<T>(", "private sealed record SessionRequestLease");
  assertOrdered(begin, [
    "lock (_connectionBoundaryGate)",
    "expectedEpoch != SessionEpoch",
    "CancellationTokenSource.CreateLinkedTokenSource",
    "_connectionBoundary.Token",
    "var started = start(lifetime.Token)"
  ], "client epoch change and actual action start must share one boundary gate");
  const publish = section(client, "private void PublishSession(", "private static VNextDevelopmentException BuildAuthException");
  assert.match(publish, /lock \(_connectionBoundaryGate\)[\s\S]*Interlocked\.Increment\(ref _sessionEpoch\)[\s\S]*CancelAndDispose\(previousBoundary\)/);
  const invalidate = section(client, "private void InvalidateSessionIfCurrentUnderGate(", "private static void CancelAndDispose(");
  assert.match(invalidate, /lock \(_connectionBoundaryGate\)[\s\S]*Interlocked\.Increment\(ref _sessionEpoch\)[\s\S]*_connectionBoundary = new CancellationTokenSource\(\)/);
  assert.match(agent, /_client\.SessionChanged -= Client_SessionChanged/);
});

test("adopted principal is pinned across refresh and every refreshed token is reauthorized", async () => {
  const client = await source("VNextDevelopmentClient.cs");

  assert.match(client, /private Guid _authenticatedUserId/);
  const refresh = section(
    client,
    "private async Task<string> GetValidAccessTokenAsync(",
    "private sealed record SessionCandidate(");
  assertOrdered(refresh, [
    "var expectedUserId = _authenticatedUserId",
    "var expectedWorkspaceId = _workspaceId",
    "var candidate = ParseSession(responseText",
    "TryReadExpectedAccessTokenClaims(candidate.AccessToken, out var refreshedUserId",
    "refreshedUserId != expectedUserId",
    "ValidateAuthorizedAutomationIdentityAsync(",
    "candidate.AccessToken",
    "expectedUserId",
    "expectedWorkspaceId",
    "PublishSession("
  ], "refresh token principal and current membership revalidation");

  const claims = section(
    client,
    "private static bool TryReadExpectedAccessTokenClaims(",
    "private static SessionCandidate ParseSession(");
  assert.match(claims, /TryGetProperty\("role"/);
  assert.match(claims, /string\.Equals\(role\.GetString\(\), "authenticated", StringComparison\.Ordinal\)/);

  const adoption = section(
    client,
    "public async Task<bool> TryAdoptCollectorPairSessionAsync(",
    "public async Task<VNextDevelopmentSendResult> SendEventAsync(");
  assertOrdered(adoption, [
    "var connectionIntent = Interlocked.Increment(ref _connectionIntentRevision)",
    "ValidateAuthorizedAutomationIdentityAsync(",
    "Interlocked.Read(ref _connectionIntentRevision) != connectionIntent",
    "PublishSession("
  ], "disconnect intent must be captured before remote adoption validation");

  const invalidate = section(
    client,
    "private void InvalidateSessionIfCurrentUnderGate(",
    "private static void CancelAndDispose(");
  assert.match(invalidate, /_authenticatedUserId = Guid\.Empty/);
  const dispose = section(client, "public void Dispose()", "}\n}");
  assert.match(dispose, /_authenticatedUserId = Guid\.Empty/);
});

test("optional automation adoption has one total timeout and never gates Collector login", async () => {
  const login = await source("CollectorLoginWebForm.cs");
  const loginFlow = section(login, "private async Task LoginAsync(", "private async Task CompleteMainWindowHandoffAsync(");
  assert.match(loginFlow, /BeginAutomationSessionAdoption\(document\.RootElement\.Clone\(\), id\)/);
  assert.doesNotMatch(loginFlow, /await _automationClient\.TryAdoptCollectorPairSessionAsync/);
  assertOrdered(loginFlow, [
    "_storage.MarkAccountLoginComplete()",
    "BeginAutomationSessionAdoption(",
    "_accountLoginCommitted = true",
    "await CompleteMainWindowHandoffAsync()"
  ], "legacy login completion is independent of optional automation adoption");

  const handoff = section(login, "private async Task CompleteMainWindowHandoffAsync(", "private void BeginAutomationSessionAdoption(");
  assertOrdered(handoff, [
    "await PrepareMainWindowBeforeCloseAsync()",
    "DialogResult = DialogResult.OK",
    "Close()"
  ], "a committed Collector login closes only after the main shell is ready");
  assert.match(handoff, /phase = "prepareError"/);
  assert.doesNotMatch(handoff, /focus = "password"/);

  const begin = section(login, "private void BeginAutomationSessionAdoption(", "private async Task ObserveAutomationSessionAdoptionAsync(");
  assert.match(begin, /BeginCollectorPairSessionAdoption\(pairResponse, fallbackEmail\)/);

  const client = await source("VNextDevelopmentClient.cs");
  const tracked = section(
    client,
    "public Task<bool> BeginCollectorPairSessionAdoption(",
    "public async Task<bool> TryAdoptCollectorPairSessionAsync(");
  assert.match(tracked, /_pendingCollectorPairAdoption = adoption/);
  assert.match(tracked, /CancelAfter\(TimeSpan\.FromSeconds\(8\)\)/);
  assert.match(tracked, /TryAdoptCollectorPairSessionAsync\([\s\S]*totalTimeout\.Token/);
  assert.match(tracked, /WaitForPendingCollectorPairSessionAdoptionAsync/);
});
