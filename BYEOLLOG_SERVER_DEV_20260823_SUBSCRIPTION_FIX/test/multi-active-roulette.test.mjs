import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('several roulette drafts can be active while trigger amounts stay exclusive',async()=>{
  const sql=await source('supabase/migrations/20260903113000_multi_active_native_roulettes.sql');
  assert.match(sql,/create table if not exists public\.byeollog_native_roulette_activations/i);
  assert.match(sql,/primary key\(workspace_id,draft_id\)/i);
  assert.match(sql,/activation\.trigger_amounts&&v_amounts/i);
  assert.match(sql,/roulette trigger amount overlaps an active roulette/i);
  assert.match(sql,/create or replace function public\.activate_native_roulette_draft_v3/i);
  assert.match(sql,/p_expected_draft_version integer/i);
  assert.match(sql,/v_draft\.version_number<>p_expected_draft_version/i);
  assert.match(sql,/create or replace function public\.activate_native_roulette_service_v2/i);
  assert.match(sql,/return public\.activate_native_roulette_draft_v3/i);
  const activation=sql.slice(sql.indexOf('create or replace function public.activate_native_roulette_draft_v3'),sql.indexOf('create or replace function public.deactivate_native_roulette_draft_v3'));
  assert.doesNotMatch(activation,/v_draft\.draft<>p_snapshot/i);
  assert.doesNotMatch(activation,/errcode='40001'/i);
  assert.match(sql,/create or replace function public\.deactivate_native_roulette_draft_v3/i);
  assert.match(sql,/active_native_roulette_snapshot_v1\(p_workspace_id,p_amount\)/i);
  assert.match(sql,/activation\.trigger_amounts@>array\[p_amount\]/i);
  assert.match(sql,/'rouletteItems',v_item_names/i);
  assert.match(sql,/'dataIsolation','pre_approval','upboWrites',0/i);
  assert.match(sql,/'dataIsolation','manual_overlay_test','upboWrites',0/i);
});

test('runtime status and wallpaper resolve every active roulette',async()=>{
  const [admin,wallpaper,service]=await Promise.all([
    source('api/admin.js'),source('lib/wallpaper-service.js'),source('lib/soop-roulette-service.js')
  ]);
  assert.match(admin,/activeDrafts:/);
  assert.match(admin,/action==='deactivate'/);
  assert.match(admin,/p_expected_draft_version:stored\.version_number/);
  assert.match(admin,/roulette_trigger_overlap/);
  assert.match(wallpaper,/activeSnapshots/);
  assert.match(wallpaper,/for\(const snapshot of activeSnapshots\)/);
  assert.match(service,/Array\.isArray\(commandPayload\.rouletteItems\)/);
});
