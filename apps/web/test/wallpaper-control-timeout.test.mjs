import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentWallpaperControl} from '../lib/agent-wallpaper-control.js';

const workspaceId='11111111-1111-4111-8111-111111111111';
const userId='22222222-2222-4222-8222-222222222222';

test('wallpaper state reconstruction honors the request deadline',async()=>{
  const stages=[];
  const signal=AbortSignal.timeout(30);
  const started=Date.now();
  await assert.rejects(
    runAgentWallpaperControl({workspaceId,userId,signal,onStage:value=>stages.push(value),
      loadStateImpl:()=>new Promise(()=>{})}),
    error=>error?.name==='TimeoutError'
  );
  assert.ok(Date.now()-started<500);
  assert.deepEqual(stages,['state:load']);
});

test('wallpaper mutations propagate the same deadline into RPC and state reload',async()=>{
  const signal=AbortSignal.timeout(1_000),seen=[];
  const result=await runAgentWallpaperControl({
    workspaceId,userId,signal,
    body:{action:'select-sessions',sessionIds:[]},
    sbImpl:async(table,path,options)=>{seen.push({table,signal:options?.signal});return 7},
    loadStateImpl:async(id,options)=>{seen.push({table:'state',signal:options.signal});return {revision:7}}
  });
  assert.equal(result.ok,true);
  assert.equal(result.revision,7);
  assert.equal(seen.length,2);
  assert.ok(seen.every(entry=>entry.signal===signal));
});

test('a queued wallpaper write that times out never runs after the active write',async()=>{
  let releaseFirst,secondCalls=0;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve});
  const first=runAgentWallpaperControl({workspaceId,userId,body:{action:'select-sessions',sessionIds:[]},
    sbImpl:async()=>{await firstGate;return 1},loadStateImpl:async()=>({revision:1})});
  const signal=AbortSignal.timeout(25);
  const second=runAgentWallpaperControl({workspaceId,userId,signal,body:{action:'save-size-rules',expectedRevision:1,sizeRules:[]},
    sbImpl:async()=>{secondCalls++;return 2},loadStateImpl:async()=>({revision:2})});
  await assert.rejects(second,error=>error?.name==='TimeoutError');
  releaseFirst();
  await first;
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(secondCalls,0);
});

test('route deadline and database retry idempotency remain deployment gates',async()=>{
  const [route,migration]=await Promise.all([
    readFile(new URL('../api/login.js',import.meta.url),'utf8'),
    readFile(new URL('../supabase/migrations/20260906125111_make_wallpaper_control_retries_idempotent.sql',import.meta.url),'utf8')
  ]);
  assert.match(route,/AbortSignal\.timeout\(18_000\)/);
  assert.match(route,/wallpaper_upstream_timeout/);
  assert.match(route,/timed out',\{stage\}/);
  assert.match(migration,/v_current_ids=p_session_ids then return v_revision/);
  assert.match(migration,/v_current_ranges,'\[\]'::jsonb\)=v_ranges/);
  assert.match(migration,/set lock_timeout='1s'/);
});
