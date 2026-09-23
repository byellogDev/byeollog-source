import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EncryptedGatewayOutbox} from '../../services/soop-gateway/services/soop-chat-gateway/outbox.mjs';
import {enqueueDurably} from '../../services/soop-gateway/services/soop-chat-gateway/durable-enqueue.mjs';
import {WorkspaceEventSequencer} from '../../services/soop-gateway/services/soop-chat-gateway/workspace-event-sequencer.mjs';
const secret='isolated-durable-queue-secret-never-production-1234';
const body=n=>({workspaceId:'fixture',relay:{connection:{id:'fixture',sequence:n},event:{message:'private-fixture-'+n}}});
async function fixture(run){const directory=await mkdtemp(join(tmpdir(),'durable-enqueue-'));try{const box=new EncryptedGatewayOutbox({directory,secret,maxItems:2,reserveItems:2});await box.init();await run(box,directory)}finally{await rm(directory,{recursive:true,force:true})}}
test('reserve ciphertext survives restart, shares FIFO, and is readable by old outbox options',()=>fixture(async(box,directory)=>{
 for(let n=0;n<4;n++){const item=await enqueueDurably(box,body(n));assert.equal(item.capacityReserve===true,n>=2);assert.doesNotMatch(await readFile(box.pathFor(item.id),'utf8'),/private-fixture/)}
 assert.equal((await enqueueDurably(box,body(3))).duplicate,true);
 const oldReader=new EncryptedGatewayOutbox({directory,secret,maxItems:2});await oldReader.init();const delivered=[];await oldReader.flush(async b=>delivered.push(b.relay.connection.sequence));assert.deepEqual(delivered,[0,1,2,3]);
}));
test('full reserve keeps sequencer pending and recovers in order when delivery frees space',()=>fixture(async box=>{
 for(let n=0;n<4;n++)await enqueueDurably(box,body(n));const seq=new WorkspaceEventSequencer(),received=[],notices=[];let release;const gate=new Promise(r=>release=r);
 const pending=seq.run('fixture',()=>enqueueDurably(box,body(4),{onBlocked:x=>notices.push(x),sleep:()=>gate}));
 while(!notices.length)await new Promise(r=>setTimeout(r,2));assert.equal(seq.pendingItems,1);assert.equal(await box.count(),4);
 await box.flush(async b=>received.push(b.relay.connection.sequence));release();await pending;await seq.drain();await box.flush(async b=>received.push(b.relay.connection.sequence));assert.deepEqual(received,[0,1,2,3,4]);assert.equal(seq.pendingItems,0);
}));
test('transient disk errors retry without losing body; unexpected validation errors still reject',async()=>{
 let attempts=0;const expected=body(0),codes=['ENOSPC','EIO','outbox_disk_reserve'];const fake={enqueue:async b=>{assert.equal(b,expected);if(attempts<codes.length)throw Object.assign(Error('fixture'),{code:codes[attempts++]});return {id:'fixture'}}};
 assert.deepEqual(await enqueueDurably(fake,expected,{sleep:async()=>{}}),{id:'fixture'});
 await assert.rejects(enqueueDurably({enqueue:async()=>{throw Object.assign(Error('bad'),{code:'invalid_payload'})}},expected),{code:'invalid_payload'});
});
