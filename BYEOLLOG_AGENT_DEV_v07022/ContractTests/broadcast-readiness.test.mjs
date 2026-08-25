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

const expectedKeys = [
  "vnext_session",
  "active_rule_scope",
  "agent_runtime",
  "agent_database",
  "obs_websocket",
  "obs_voice_anonymizer",
  "windows_microphone",
  "overlay_loopback",
  "approved_assets",
  "ack_queue",
  "timed_mute_recovery"
];

test("broadcast readiness exposes exactly eleven stable keys across one runtime branch", async () => {
  const [policy, preflight] = await Promise.all([
    source("BroadcastReadiness.cs"),
    source("CollectorPreflight.cs")
  ]);
  const keyBlock = section(policy, "FixedCheckKeys = new[]", "};");
  const keys = [...keyBlock.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
  assert.deepEqual(keys, expectedKeys);
  assert.equal(new Set(keys).size, 11, "readiness keys must be unique");

  const run = section(preflight, "public static async Task<CollectorPreflightReport> RunAsync(", "private sealed record WindowsMicrophoneProbe");
  const emitted = [...run.matchAll(/checks\.Add\(Check\(\s*"([a-z][a-z0-9_]*)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(emitted)].sort(), [...expectedKeys].sort());
  for (const key of expectedKeys) {
    const count = emitted.filter((candidate) => candidate === key).length;
    assert.equal(
      count,
      key === "active_rule_scope" ? 2 : 1,
      `${key} must have one call site, except the mutually exclusive scope success/failure branches`
    );
  }
  assert.match(run, /checks\.AsReadOnly\(\)/);
});

test("rule and approved-asset discovery use a 101st sentinel and fail closed above 100", async () => {
  const activityClient = await source("VNextActivityClient.cs");
  const rules = section(
    activityClient,
    "public async Task<IReadOnlyList<VNextReadinessRequirement>> LoadBroadcastReadinessRequirementsAsync(",
    "public async Task<IReadOnlyList<VNextApprovedAssetReference>>");
  const assets = section(
    activityClient,
    "public async Task<IReadOnlyList<VNextApprovedAssetReference>> LoadApprovedAssetReferencesAsync(",
    "private static VNextDevelopmentException InvalidActivityResponse()");

  assert.match(rules, /enabled=eq\.true&superseded_at=is\.null/);
  assert.match(rules, /id,rule_actions\(action_type,execution_target,agent_device_id,overlay_asset_id\)/);
  assert.doesNotMatch(rules, /rule_conditions|params|name,message|actor/i);
  assertOrdered(rules, [
    "&order=created_at.desc&limit=101",
    "result.GetArrayLength() > 100",
    "readiness_rule_scope_saturated",
    "foreach (var rule in result.EnumerateArray())"
  ], "rule scope sentinel");

  assert.match(assets, /id,content_sha256/);
  assert.doesNotMatch(assets, /display_name|download_path|storage|payload/i);
  assertOrdered(assets, [
    "&order=id.asc&limit=101",
    "result.GetArrayLength() > 100",
    "approved_asset_scope_saturated",
    "foreach (var row in result.EnumerateArray())"
  ], "approved asset sentinel");

  const preflight = await source("CollectorPreflight.cs");
  const run = section(preflight, "public static async Task<CollectorPreflightReport> RunAsync(", "private sealed record WindowsMicrophoneProbe");
  const scopeFailure = section(run, "catch\n        {", "VNextLocalAgentPreflight? agent");
  assert.match(scopeFailure, /"active_rule_scope"[\s\S]*"blocked"/);
  assert.match(run, /var localRequired = !scopeLoaded/);
  assert.match(run, /!scopeLoaded \|\| scope\.RequiresObs[\s\S]*"blocked"/);
});

test("OBS is conditional and approved overlays require an exact asset ID plus SHA-256 pair", async () => {
  const [policy, preflight] = await Promise.all([
    source("BroadcastReadiness.cs"),
    source("CollectorPreflight.cs")
  ]);
  const derive = section(policy, "public static BroadcastReadinessScope FromRequirements(", "public static bool ExactAssetsReady(");
  assert.match(derive, /ExecutionTarget, "local_agent"/);
  assert.match(derive, /TimedMuteActionAdapter\.ObsActionType/);
  assert.match(derive, /TimedMuteActionAdapter\.VoiceAnonymizerActionType/);
  assert.match(derive, /"obs\.set_input_mute"/);
  assert.match(derive, /TimedMuteActionAdapter\.WindowsActionType/);
  assert.match(derive, /current\.Any\(item =>[\s\S]*ObsActionType[\s\S]*obs\.set_input_mute/);
  assert.match(derive, /var unsupported = current\.Any/);
  assert.match(derive, /HasUnsupportedLocalActions|unsupported/);

  const exact = section(policy, "public static bool ExactAssetsReady(", "}\n}");
  assertOrdered(exact, [
    "approved.ToDictionary",
    "item.AssetId",
    "item.ContentSha256",
    "localReady.Select(item => item.AssetId.ToLowerInvariant() + \":\" + item.ContentSha256)",
    "approvedById.TryGetValue(assetId, out var expectedSha)",
    "local.Contains(assetId.ToLowerInvariant() + \":\" + expectedSha)"
  ], "exact approved/local revision match");
  assert.equal([...exact.matchAll(/return false;/g)].length, 2, "missing ID and mismatched SHA must both fail closed");

  const run = section(preflight, "public static async Task<CollectorPreflightReport> RunAsync(", "private sealed record WindowsMicrophoneProbe");
  const obs = section(run, "checks.Add(Check(\n            \"obs_websocket\"", "var windows = await ProbeWindowsMicrophoneAsync");
  assert.match(obs, /!scopeLoaded \|\| scope\.RequiresObs/);
  assert.match(obs, /: "pass"/);
  assert.match(obs, /활성 OBS 규칙 없음/);
  assert.match(obs, /"obs_voice_anonymizer"/);
  assert.match(obs, /ProbeVoiceAnonymizerAsync/);
  assert.match(obs, /voice\.FilterEnabled \? "attention" : "pass"/);
  assert.match(run, /scope\.HasUnsupportedLocalActions \? "blocked" : "pass"/);
  assert.match(run, /지원하지 않는 로컬 액션/);
  assert.match(run, /BroadcastReadinessPolicy\.ExactAssetsReady\([\s\S]*scope\.RequiredOverlayAssetIds,[\s\S]*approvedAssets,[\s\S]*overlay\.ReadyRevisions/);
});
