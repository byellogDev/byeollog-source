import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTaskCompletionHistory} from '../lib/task-completion-history.js';
const workspace='10000000-0000-4000-8000-000000000001';
test('completion history scopes reads, bounds pages and preserves microsecond cursors',async()=>{
 const rows=Array.from({length:51},(_,i)=>({id:`20000000-0000-4000-8000-${String(i).padStart(12,'0')}`,occurred_at:'2026-09-20T00:00:00.123456+00:00'}));
 const result=await loadTaskCompletionHistory(workspace,null,{sbImpl:async(table,path)=>{
  assert.equal(table,'byeollog_task_completion_history');const p=new URLSearchParams(path);assert.equal(p.get('workspace_id'),'eq.'+workspace);assert.equal(p.get('limit'),'51');assert.equal(p.get('order'),'occurred_at.desc,id.desc');return rows;
 }});
 assert.equal(result.items.length,50);assert.deepEqual(result.cursor,{at:rows[49].occurred_at,id:rows[49].id});
 await loadTaskCompletionHistory(workspace,JSON.stringify(result.cursor),{sbImpl:async(_,path)=>{assert.equal(new URLSearchParams(path).get('or'),`(occurred_at.lt.${rows[49].occurred_at},and(occurred_at.eq.${rows[49].occurred_at},id.lt.${rows[49].id}))`);return []}});
});
test('history rejects malformed or injected cursor before querying',async()=>{
 for(const cursor of ['{',JSON.stringify({at:'2026-09-20T00:00:00Z),workspace_id.neq.null',id:workspace}),JSON.stringify({at:'2026-09-20T00:00:00Z',id:'not-a-uuid'}),'x'.repeat(201)]){
  await assert.rejects(loadTaskCompletionHistory(workspace,cursor,{sbImpl:()=>assert.fail('must not query')}),e=>e.status===400);
 }
 await assert.rejects(loadTaskCompletionHistory('invalid',null),e=>e.status===403);
});
