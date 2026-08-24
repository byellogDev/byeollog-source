import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {
  rouletteExternalEventId,
  rewardMultiplierLedgerKeys
} from '../lib/collector-processor.js';

test('collector derives the same stable roulette event identity used by the Agent',()=>{
  const row={session_id:'session-1',source_uid:'source-1',donated_time_text:'2026-08-23 12:34:56'};
  const hash=createHash('sha256').update('session-1|source-1|2026-08-23 12:34:56','utf8').digest('hex').slice(0,32);
  assert.equal(rouletteExternalEventId(row,0),`weflab_${hash}_roulette_1`);
  assert.equal(rouletteExternalEventId(row,1),`weflab_${hash}_roulette_2`);
});

test('one applied multiplier creates deterministic idempotent upbo ledger keys',()=>{
  assert.deepEqual(rewardMultiplierLedgerKeys('event|0',4),[
    'event|0',
    'event|0|reward-multiplier-2',
    'event|0|reward-multiplier-3',
    'event|0|reward-multiplier-4'
  ]);
  assert.equal(rewardMultiplierLedgerKeys('event|0',999).length,100);
  assert.deepEqual(rewardMultiplierLedgerKeys('event|0',0),['event|0']);
});

test('collector delegates same-donor one-use state to the canonical database resolver',async()=>{
  const processor=await readFile(new URL('../lib/collector-processor.js',import.meta.url),'utf8');
  assert.match(processor,/rpc\/resolve_roulette_reward_multiplier_v1/);
  assert.match(processor,/p_actor_id:actorId\|\|null/);
  assert.match(processor,/p_source_event_key:rouletteExternalEventId\(row,index\)/);
  assert.match(processor,/p_allow_stacking:control\?control\.allowStacking:null/);
  assert.match(processor,/saveDonation\(claimed,assessment\.results\|\|\[\],workspaceId\)/);
});

test('an immediate no-reward result consumes the multiplier as a dud instead of carrying it forward',async()=>{
  const processor=await readFile(new URL('../lib/collector-processor.js',import.meta.url),'utf8');
  const migration=await readFile(new URL(
    '../supabase/migrations/20260822234535_next_roulette_reward_multiplier.sql',import.meta.url),'utf8');

  const resolveAt=processor.indexOf('const resolvedResults=await resolveRewardMultipliers');
  const fixedRewardAt=processor.indexOf('await createFixedTasks',resolveAt);
  const rouletteRewardAt=processor.indexOf('await createTasks',resolveAt);
  assert.ok(resolveAt>=0&&resolveAt<fixedRewardAt&&resolveAt<rouletteRewardAt);
  assert.match(processor,/비업보\/비액션 결과도 꽝으로 소비/);
  assert.match(processor,/if\(rr\.multiplierControl\|\|!rule\|\|rule\.action!=='include'\)continue/);

  const consumeMatch=migration.match(
    /\n  else\s+if v_pending\.workspace_id is not null then([\s\S]*?)insert into byeollog_automation\.roulette_reward_multiplier_receipts/
  );
  assert.ok(consumeMatch);
  const consumeBranch=consumeMatch[1];
  assert.match(consumeBranch,/v_applied := v_pending\.multiplier/);
  assert.match(consumeBranch,/set multiplier = null/);
  assert.doesNotMatch(consumeBranch,/action_type|upbo|processable|rule\.action/);
});

test('production checkpoint contains the canonical multiplier schema and trigger chain',async()=>{
  const migration=await readFile(new URL(
    '../supabase/migrations/20260822234535_next_roulette_reward_multiplier.sql',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists byeollog_automation\.roulette_reward_multiplier_state/);
  assert.match(migration,/primary key \(workspace_id, actor_key\)/);
  assert.match(migration,/v_actor_key text := lower\(nullif\(btrim\(coalesce\(p_actor_id, ''\)\), ''\)\)/);
  assert.match(migration,/v_now \+ interval '12 hours'/);
  assert.match(migration,/create trigger capture_roulette_reward_multiplier_v1[\s\S]*after insert on byeollog_automation\.events/);
  assert.match(migration,/create trigger apply_roulette_reward_multiplier_v1[\s\S]*before insert on byeollog_automation\.executions/);
  assert.match(migration,/least\(900000, v_duration \* v_multiplier\)/);
  assert.match(migration,/least\(200, v_quantity \* v_multiplier\)/);
  assert.match(migration,/grant execute on function public\.resolve_roulette_reward_multiplier_v1[\s\S]*to service_role/);
});

test('collector server role has the narrow read grants required to load multiplier rules',async()=>{
  const migration=await readFile(new URL(
    '../supabase/migrations/20260823162319_restore_collector_rule_read_access.sql',import.meta.url),'utf8');
  for(const table of ['rules','rule_conditions','rule_actions']){
    assert.match(migration,new RegExp(`grant select on table public\\.${table} to service_role`));
  }
  assert.doesNotMatch(migration,/grant\s+(?:insert|update|delete|all)\b/i);
  assert.doesNotMatch(migration,/\bto\s+(?:public|anon|authenticated)\b/i);
});
