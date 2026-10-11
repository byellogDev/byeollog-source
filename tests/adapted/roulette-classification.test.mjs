import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getRouletteClassificationHtml} from '../../apps/admin-runtime/lib/roulette-classification-html.js';

const source=path=>readFile(auditURL(path,import.meta.url),'utf8');

test('collection setup needs only URL and ON; names are optional',()=>{
 const page=getRouletteClassificationHtml('test-nonce');
 assert.match(page,/업보 수집 설정/);assert.match(page,/이벤트명 사전 등록/);
 assert.match(page,/id="collectionToggle"[^>]*disabled/);assert.match(page,/10월 330개/);
 assert.doesNotMatch(page,/id="rouletteSpins"|공개 링크에서 가져오기|id="weflabUrl"/);
 assert.match(page,/id="fixedTab"/);assert.match(page,/id="specialTab"/);
});

test('fixed Upbo rules are server-only and SDK donation ingestion emits processing work',async()=>{
  const sql=await source('../supabase/migrations/20260903172926_add_fixed_upbo_classification.sql');
  assert.match(sql,/primary key \(workspace_id, balloons, event_name, upbo_type\)/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/for all to anon, authenticated[\s\S]*using \(false\) with check \(false\)/);
  assert.match(sql,/revoke all on table public\.byeollog_fixed_upbo_rules from public, anon, authenticated, service_role/);
  assert.match(sql,/jsonb_agg\(jsonb_build_object\([\s\S]*'event_name'[\s\S]*'upbo_type'[\s\S]*'quantity'/);
  assert.match(sql,/insert into public\.bangsel_collector_staging[\s\S]*fixed_rewards/);
  assert.match(sql,/'sourceUid',v_source_uid/);
});

test('roulette amount mappings are private and rename SDK donations before classification',async()=>{
  const sql=await source('../supabase/migrations/20260903175336_add_roulette_amount_mappings.sql');
  assert.match(sql,/primary key \(workspace_id, balloons\)/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/for all to anon, authenticated[\s\S]*using \(false\) with check \(false\)/);
  assert.match(sql,/new\.raw_payload->>'source_provider',''\)<>'soop_chat_sdk'/);
  assert.match(sql,/new\.event_name:=v_name/);
  assert.match(sql,/update public\.bangsel_donations donation/);
});

test('collector leaves Upbo classification entirely to the learned result rules',async()=>{
  const processor=await source('../lib/collector-processor.js');
  assert.match(processor,/bangsel_roulette_rules/);
  assert.match(processor,/rules\.get\(result\)/);
  assert.doesNotMatch(processor,/byeollog_roulette_classification_rules|roulette_name,result_text/);
});
