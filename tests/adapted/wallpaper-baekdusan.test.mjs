import test from 'node:test';
import assert from 'node:assert/strict';
import {readBaekdusanLog} from '../../apps/admin-runtime/lib/wallpaper-baekdusan.js';
import {runAgentWallpaperControl} from '../../apps/admin-runtime/lib/agent-wallpaper-control.js';
const workspace='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
test('baekdusan reads use authenticated workspace, selected session and stable sequence, never display visibility',async()=>{
  const calls=[];
  const result=await runAgentWallpaperControl({workspaceId:workspace,userId:'test',body:{action:'baekdusan-log',sessionId:session,workspaceId:session,afterSequence:32},sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});assert.ok(path.includes(`workspace_id=eq.${workspace}`));
    if(table==='byeollog_wallpaper_sessions')return [{id:session,state:'active'}];
    assert.ok(path.includes(`session_id=eq.${session}`));assert.ok(path.includes('display_kind=eq.donation'));assert.ok(path.includes('sequence_no=gt.32'));assert.ok(path.includes('order=sequence_no.asc'));
    assert.ok(!path.includes('visible'));return [{id:'tip',session_id:session,sequence_no:33,amount:33,actor_name:'참여자',received_at:'2026-09-29T00:00:00Z'}];
  }});
  assert.equal(result.tiles[0].amount,33);assert.equal(result.nextSequence,33);assert.equal(result.closed,false);assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.options?.method));
});
test('foreign or expired session returns no donation records',async()=>{
  let calls=0;await assert.rejects(()=>readBaekdusanLog(workspace,{sessionId:session},async()=>{calls++;return [];},null),e=>e.status===404);assert.equal(calls,1);
});
test('pagination has bounded metadata, exact cursor, no raw assets or hidden payload',async()=>{
  const result=await readBaekdusanLog(workspace,{sessionId:session,amount:1},async(t,p)=>{
    if(t.endsWith('_sessions'))return [{state:'closed'}];
    assert.match(p,/amount=eq.1/);assert.match(p,/limit=201/);
    return Array.from({length:201},(_,i)=>({id:String(i),session_id:session,sequence_no:i+1,actor_name:'가',amount:1,asset:{secret:'not exported'}}));
  });
  assert.equal(result.tiles.length,200);assert.equal(result.hasMore,true);assert.equal(result.nextSequence,200);assert.equal(result.closed,true);assert.ok(!JSON.stringify(result).includes('secret'));
});
for(const body of [{sessionId:'x'},{sessionId:session,afterSequence:-1},{sessionId:session,amount:0},{sessionId:session,tileId:'x'},{sessionId:session,afterSequence:1.5}])
  test('invalid baekdusan input fails before database access '+JSON.stringify(body),async()=>{await assert.rejects(()=>readBaekdusanLog(workspace,body,()=>{throw Error('must not query')}),e=>e.status===400)});
