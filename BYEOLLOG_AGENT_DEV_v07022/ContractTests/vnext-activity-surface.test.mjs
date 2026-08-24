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

test("activity loads only through the workspace-scoped bounded safe RPC", async () => {
  const activityClient = await source("VNextActivityClient.cs");
  const load = section(
    activityClient,
    "public async Task<VNextActivityPage> LoadActivityAsync(",
    "public async Task<IReadOnlyList<VNextReadinessRequirement>>");

  assert.equal(
    [...load.matchAll(/\/rest\/v1\/rpc\/list_automation_activity_v1/g)].length,
    1,
    "activity must have one canonical RPC endpoint"
  );
  assert.match(load, /HttpMethod\.Post/);
  assert.match(load, /new \{ p_workspace_id = WorkspaceId, p_limit = limit \}/);
  assert.match(load, /limit is < 1 or > 100/);
  assertOrdered(load, [
    "if (limit is < 1 or > 100)",
    "var token = await GetValidAccessTokenAsync",
    "/rest/v1/rpc/list_automation_activity_v1",
    "result.GetArrayLength() > limit",
    "foreach (var row in result.EnumerateArray())"
  ], "bounded activity request");
  assert.doesNotMatch(load, /HttpMethod\.Get|\/rest\/v1\/(?!rpc\/)/);
  assert.doesNotMatch(load, /service_role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i);
});

test("safe activity rows are duplicate-free and parsed through strict bounded types", async () => {
  const activityClient = await source("VNextActivityClient.cs");
  const load = section(
    activityClient,
    "public async Task<VNextActivityPage> LoadActivityAsync(",
    "public async Task<IReadOnlyList<VNextReadinessRequirement>>");

  assertOrdered(load, [
    "var ids = new HashSet<string>(StringComparer.Ordinal)",
    "var id = ActivityGuid(row, \"id\")",
    "if (!ids.Add(id)) throw InvalidActivityResponse()"
  ], "duplicate activity IDs fail closed");
  for (const invariant of [
    "ActivityStatuses.Contains(status)",
    "attemptCount > maxAttempts",
    "ActivitySymbolPattern.IsMatch(actionType)",
    "ActivityDispositions.Contains(disposition)",
    "ActivityCodePattern.IsMatch(errorCode)",
    "ActivityTimestamp(row, \"created_at\", required: true)",
    "ActivityTimestamp(row, \"updated_at\", required: true)",
    "ActivityTimestamp(row, \"event_occurred_at\", required: true)"
  ]) assert.ok(load.includes(invariant), `missing strict activity invariant: ${invariant}`);
  assert.match(load, /rows\.Count == limit/);
  assert.match(activityClient, /invalid_activity_response/);
});

test("browser and Agent activity surfaces cannot fall back to raw execution tables", async () => {
  const [activityClient, form, monitor, html] = await Promise.all([
    source("VNextActivityClient.cs"),
    source("VNextAutomationSettingsForm.cs"),
    source("VNextActivityMonitor.cs"),
    source("Ui/agent_automation.html")
  ]);
  const exposed = [activityClient, form, monitor, html].join("\n");
  const rawTablePath = /\/rest\/v1\/(?:events?|normalized_events?|automation_events?|event_executions?|executions?|execution_attempts?|delivery_attempts?)(?:[?\/]|\b)/i;
  assert.doesNotMatch(exposed, rawTablePath);
  assert.doesNotMatch(exposed, /(?:from|table)\s*\(\s*["'](?:events?|event_executions?|execution_attempts?)["']\s*\)/i);

  const fullState = section(form, "private async Task LoadAndPushStateAsync(", "private async Task LoadActivityAndPushAsync(");
  const activityRefresh = section(form, "private async Task LoadActivityAndPushAsync(", "private async Task LoadReadinessAndPushAsync(");
  assert.match(fullState, /_client\.LoadActivityAsync\(100, _lifetimeToken\)/);
  assert.match(activityRefresh, /_client\.LoadActivityAsync\(100, _lifetimeToken\)/);
  assert.doesNotMatch(activityRefresh, /SendAutomationRequestAsync|HttpClient|\/rest\/v1\//);
  assert.match(monitor, /_client\.LoadActivityAsync\(100, linked\.Token\)/);
});
