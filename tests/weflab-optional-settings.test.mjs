import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('optional URL does not enroll accounts or bypass safety stop',()=>{
 const sql=fs.readFileSync(new URL('../supabase/migrations/20261007231117_weflab_optional_settings.sql',import.meta.url),'utf8');
 const fn=sql.slice(sql.indexOf('create function byeollog_weflab_trial.settings'),sql.indexOf('create or replace function'));
 assert.match(fn,/g3a_assert_active_auth_session_v1/);assert.match(fn,/m.role in \('owner','manager'\)/);
 assert.doesNotMatch(fn,/insert into byeollog_weflab_trial.campaigns|set enabled=true/);
 assert.match(sql,/not c.enabled or not exists/);assert.match(sql,/s.url=c.config->>'url' and s.url<>''/);
 assert.match(sql,/and action<>'complete'/);assert.match(sql,/revoke all on byeollog_weflab_trial.settings from public,anon,authenticated/);
});
