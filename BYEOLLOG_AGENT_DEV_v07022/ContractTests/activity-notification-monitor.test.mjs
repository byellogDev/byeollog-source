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

test("monitor uses one 60-second loop and a silent first successful baseline", async () => {
  const monitor = await source("VNextActivityMonitor.cs");
  const constructor = section(monitor, "public VNextActivityMonitor(", "public event EventHandler<VNextActivityNotification>?");
  assert.match(constructor, /_interval = interval \?\? TimeSpan\.FromSeconds\(60\)/);
  assert.match(constructor, /_client\.SessionChanged \+= Client_SessionChanged/);

  const start = section(monitor, "public void Start()", "public void Wake()");
  assert.match(start, /_loop \?\?= Task\.Run\(\(\) => RunAsync\(_stop\.Token\)\)/);
  const loop = section(monitor, "private async Task RunAsync(", "private async Task PollOnceAsync(");
  assert.equal([...loop.matchAll(/_wake\.WaitAsync\(_interval/g)].length, 1);
  assert.equal([...loop.matchAll(/PollOnceAsync\(cancellationToken\)/g)].length, 1);

  const apply = section(monitor, "public VNextActivityNotification Apply(", "internal static VNextActivityAlertState Classify(");
  assertOrdered(apply, [
    "if (!_hasBaseline)",
    "_hasBaseline = true",
    "return new VNextActivityNotification(0, 0, 0, 0)",
    "var blocked = 0"
  ], "first successful page establishes a silent baseline");
  assert.match(loop, /A failed poll never advances the baseline/);
});

test("notification payload is aggregate-only and tracks only explicit state transitions", async () => {
  const monitor = await source("VNextActivityMonitor.cs");
  const notificationDeclaration = section(
    monitor,
    "internal sealed record VNextActivityNotification(",
    "internal sealed class VNextActivityTransitionTracker");
  const parameters = notificationDeclaration
    .slice(0, notificationDeclaration.indexOf(")"))
    .match(/int\s+([A-Za-z]+)/g)?.map((value) => value.replace(/^int\s+/, "")) ?? [];
  assert.deepEqual(parameters, ["Blocked", "NeedsReview", "RecoveryDelayed", "Recovered"]);
  assert.doesNotMatch(notificationDeclaration, /string\s+(?:Id|Name|Message|Actor|Rule)|VNextActivityItem|Workspace|Device/i);
  assert.match(notificationDeclaration, /public int Total => Blocked \+ NeedsReview \+ RecoveryDelayed \+ Recovered/);

  const apply = section(monitor, "public VNextActivityNotification Apply(", "internal static VNextActivityAlertState Classify(");
  assert.match(apply, /if \(!hadPrevious \|\| previous != next\)/);
  assert.match(apply, /switch \(next\)/);
  assert.match(apply, /Blocked: blocked\+\+/);
  assert.match(apply, /NeedsReview: needsReview\+\+/);
  assert.match(apply, /RecoveryDelayed: recoveryDelayed\+\+/);
  assert.match(apply, /previous != VNextActivityAlertState\.None[\s\S]*item\.Status, "succeeded"[\s\S]*recovered\+\+/);
  assert.match(apply, /new VNextActivityNotification\(blocked, needsReview, recoveryDelayed, recovered\)/);
  assert.doesNotMatch(apply, /ActorName|ActorId|RuleName|EventType|ErrorCode/);
});

test("each poll crosses three epoch fences and session changes cancel then reset the baseline", async () => {
  const monitor = await source("VNextActivityMonitor.cs");
  const poll = section(monitor, "private async Task PollOnceAsync(", "private void Client_SessionChanged(");
  assert.ok(
    [...poll.matchAll(/_client\.IsSessionEpochCurrent\(epoch\)/g)].length >= 3,
    "poll must fence before request, after response, and immediately before delivery"
  );
  assertOrdered(poll, [
    "var epoch = _client.CaptureSessionEpoch()",
    "if (!_client.IsSessionEpochCurrent(epoch)) return",
    "CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, epochToken)",
    "await _client.LoadActivityAsync(100, linked.Token)",
    "if (!_client.IsSessionEpochCurrent(epoch)) return",
    "_tracker.Apply(page, DateTimeOffset.UtcNow)",
    "SessionEpoch = epoch",
    "if (notification.Total == 0) return",
    "if (!_client.IsSessionEpochCurrent(epoch)) return",
    "NotificationReady?.Invoke(this, notification)"
  ], "three epoch fences");

  const changed = section(monitor, "private void Client_SessionChanged(", "public async Task StopAsync()");
  assertOrdered(changed, [
    "_epochCancellation.Cancel()",
    "_epochCancellation.Dispose()",
    "_epochCancellation = new CancellationTokenSource()",
    "_tracker.Reset()",
    "Wake()"
  ], "epoch cancellation and baseline reset");
});

test("application lifecycle owns, starts, displays, and stops exactly one activity monitor", async () => {
  const [program, main] = await Promise.all([
    source("Program.cs"),
    source("MainForm.cs")
  ]);
  const ownership = `${program}\n${main}`;
  assert.equal(
    [...ownership.matchAll(/new VNextActivityMonitor\(/g)].length,
    1,
    "the application must own exactly one monitor instance"
  );
  assert.match(ownership, /NotificationReady\s*\+=/);
  assert.match(ownership, /(?:activityMonitor|_activityMonitor)\.Start\(\)/i);
  assert.match(ownership, /(?:activityMonitor|_activityMonitor)\.(?:StopAsync|Dispose)\(/i);
  assert.match(ownership, /\.Summary\(\)/);
  assert.match(
    main,
    /_vNextDevClient\.SessionEpoch != notification\.SessionEpoch/,
    "a queued UI callback must recheck the notification's issuing epoch"
  );
  assert.doesNotMatch(ownership, /NotificationReady[\s\S]{0,500}(?:ActorName|ActorId|RuleName|EventType|ErrorCode)/);
});
