import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260831045843_agent_realtime_wake_channel.sql",
  import.meta.url
);

test("Agent wake migration exposes only private, membership-authorized Broadcast hints", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /security definer/gi);
  assert.match(sql, /set search_path = ''/gi);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /select case\s+when p_topic ~/i);
  assert.match(sql, /else false\s+end;/i);
  assert.match(sql, /byeollog_workspace_members/);
  assert.match(sql, /agent_devices/);
  assert.match(sql, /revoked_at is null/);
  assert.match(sql, /on realtime\.messages\s+for select\s+to authenticated/i);
  assert.match(sql, /realtime\.messages\.extension = 'broadcast'/);
  assert.match(sql, /realtime\.topic\(\)/);
  assert.match(sql, /revoke all on function[\s\S]+from public, anon, authenticated/gi);
  assert.doesNotMatch(sql, /create\s+table\s+realtime\.|alter\s+table\s+realtime\.|drop\s+table\s+realtime\./i);
});

test("Execution and wallpaper writes emit failure-isolated wake hints without action payloads", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /new\.execution_target <> 'local_agent'/);
  assert.match(sql, /new\.status not in \('queued', 'retry_scheduled'\)/);
  assert.match(sql, /jsonb_build_object\('notBefore', new\.next_attempt_at\)/);
  assert.match(sql, /'execution_changed'/);
  assert.match(sql, /jsonb_build_object\('revision', new\.revision\)/);
  assert.match(sql, /'wallpaper_changed'/);
  assert.match(sql, /'agent-wake:' \|\| new\.workspace_id::text/);
  assert.match(sql, /exception when others then/g);
  assert.match(sql, /return new;/g);
  assert.doesNotMatch(sql, /action_params|device_secret|result_payload/i);
});
