import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainForm = await readFile(new URL("../MainForm.cs", import.meta.url), "utf8");
const identity = await readFile(new URL("../VNextSourceIdentity.cs", import.meta.url), "utf8");

const builder = mainForm.match(
  /private static List<VNextDevelopmentEvent> BuildVNextDevelopmentEvents\([\s\S]*?\n    private static string StableDevelopmentHash/
)?.[0] ?? "";

test("donation and roulette payloads carry the same original source UID", () => {
  assert.match(builder, /uid = VNextSourceIdentity\.RequireValid\(uid\)/);
  assert.equal(builder.match(/sourceUid = uid/g)?.length, 2);
  assert.match(builder, /StableDevelopmentHash\("weflab\|" \+ uid\)/);
  assert.doesNotMatch(builder, /session\.Id/);
});

test("real Weflab events keep starballoons as a unit instead of an invalid ISO currency", () => {
  assert.doesNotMatch(builder, /Currency:\s*amount\s*>\s*0\s*\?\s*"starballoon"/);
  assert.equal(builder.match(/Currency:\s*null/g)?.length, 2);
  assert.equal(builder.match(/amountUnit\s*=\s*amount\s*>\s*0\s*\?\s*"starballoon"/g)?.length, 2);
});

test("stale rows are still delivered for durable ledgers while timestamps remain KST-safe", () => {
  assert.match(mainForm, /MaxLiveAutomationEventAge\s*=\s*TimeSpan\.FromMinutes\(2\)/);
  assert.match(mainForm, /if \(IsStaleVNextDevelopmentRow\(row, DateTimeOffset\.UtcNow\)\) staleRows\+\+;[\s\S]*?BuildVNextDevelopmentEvents\(/);
  assert.doesNotMatch(mainForm, /if \(IsStaleVNextDevelopmentRow\(row, DateTimeOffset\.UtcNow\)\)[\s\S]{0,240}?continue;/);
  assert.match(builder, /GetVNextOccurredAtUtc\(row\) \?\? DateTimeOffset\.UnixEpoch/);
  assert.doesNotMatch(builder, /GetVNextOccurredAtUtc\(row\) \?\? DateTimeOffset\.UtcNow/);
  assert.match(mainForm, /return !occurredAt\.HasValue \|\| nowUtc - occurredAt\.Value > MaxLiveAutomationEventAge/);
  assert.match(mainForm, /new DateTimeOffset\(unspecified, TimeSpan\.FromHours\(9\)\)\.ToUniversalTime\(\)/);
});

test("Collector source UID validation matches the vNext upbo contract", () => {
  assert.match(identity, /sourceUid\.Length > 256/);
  assert.match(identity, /sourceUid\.Contains\('\|'\)/);
  assert.match(identity, /sourceUid\.Any\(char\.IsControl\)/);
});
