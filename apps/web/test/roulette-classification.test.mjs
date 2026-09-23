import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getRouletteClassificationHtml} from '../lib/roulette-classification-html.js';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('classification page asks for an inclusive balloon range, event name and expected spins',()=>{
  const page=getRouletteClassificationHtml('test-nonce');
  assert.match(page,/업보 분류 설정/);
  assert.match(page,/class="dashboardHeader"/);
  assert.match(page,/class="productNav dashboardNav"/);
  assert.match(page,/href="\/assets\/byeollog-theme\.css"/);
  assert.match(page,/id="rouletteTab"[\s\S]*>룰렛<\/button>/);
  assert.match(page,/id="fixedTab"[\s\S]*>고정<\/button>/);
  assert.match(page,/fixed-upbo-rules/);
  assert.match(page,/roulette-classification-rules/);
  assert.match(page,/id="rouletteBalloons"/);
  assert.match(page,/id="rouletteBalloonsMax"/);
  assert.match(page,/id="rouletteName"/);
  assert.match(page,/id="rouletteSpins"/);
  assert.match(page,/후원 1건당 회전 수/);
  assert.match(page,/expectedSpins:validateSpins/);
  assert.match(page,/id="weflabUrl"/);
  assert.match(page,/api\('weflab-public-import'/);
  assert.match(page,/원하는 이벤트명으로 지정해주세요/);
  assert.match(page,/처음 나온 결과는 업보 메뉴에서 한 번 분류/);
  assert.match(page,/BYEOLLOG CONTROL CENTER/);
  assert.match(page,/<label for="rouletteName">이벤트명<\/label>/);
  const roulettePanel=page.slice(page.indexOf('<section id="roulettePanel"'),page.indexOf('<section id="fixedPanel"'));
  assert.doesNotMatch(roulettePanel,/룰렛명/);
  assert.match(page,/<label for="specialResultText">룰렛명<\/label>/);
  assert.doesNotMatch(page,/검토 필요|classificationSelect|native-roulette-service|방송에 적용/);
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
