import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = auditURL(
  "../supabase/migrations/20260901232944_agent_display_latency_observations.sql",
  import.meta.url
);

test("Agent display telemetry is private, authenticated, bounded, and off the hot path", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /create table private\.agent_display_observations_v1/);
  assert.match(sql, /observation_kind in \('action_first_frame','wallpaper_ready'\)/);
  assert.match(sql, /alter table private\.agent_display_observations_v1 enable row level security/);
  assert.match(sql, /revoke all on table private\.agent_display_observations_v1\s+from public,anon,authenticated,service_role/);
  assert.match(sql, /agent_direct_runtime_context_v1/);
  assert.match(sql, /execution\.agent_device_id=p_device_id/);
  assert.match(sql, /overlay\.revision=p_wallpaper_revision/);
  assert.match(sql, /on conflict do nothing/);
  assert.match(sql, /set statement_timeout = '5s'/);
  assert.match(sql, /server_received_at < clock_timestamp\(\)-interval '14 days'/);
  assert.match(sql, /byeollog-agent-display-observation-retention-v1/);
  assert.match(sql, /grant execute on function public\.g3a_agent_direct_display_observation_v1[\s\S]*to authenticated/);
  assert.doesNotMatch(sql, /donor|nickname|message|image_url|tts_text/i);
});
