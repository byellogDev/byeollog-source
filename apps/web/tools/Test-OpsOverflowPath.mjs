// Reproduce the worker's sequencer -> durable enqueue -> log-on-error boundary.
// maxItems=1 hits the same rejection branch as production's tested 10,000 limit.
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {EncryptedGatewayOutbox} from '../services/soop-chat-gateway/outbox.mjs';
import {WorkspaceEventSequencer} from '../services/soop-chat-gateway/workspace-event-sequencer.mjs';
const root=resolve('../.tmp'),directory=await mkdtemp(join(root,'overflow-path-'));
try{
 const source=await readFile(new URL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
 assert.match(source,/const queued=await outbox\.enqueue\(body\)/);
 assert.match(source,/catch\(error=>log\('error','event_queue_failed'/);
 const box=new EncryptedGatewayOutbox({directory,secret:'fixture-only-overflow-secret-long-enough-123456',maxItems:1});await box.init();
 const first={workspaceId:'fixture',relay:{connection:{id:'fixture',sequence:1},event:{id:1}}};const second={...first,relay:{connection:{id:'fixture',sequence:2},event:{id:2}}};
 await box.enqueue(first);const sequencer=new WorkspaceEventSequencer(),errors=[];
 await sequencer.run('fixture',()=>box.enqueue(second)).catch(e=>errors.push(e.code));await sequencer.drain();
 const seen=[];await box.flush(async b=>seen.push(b.relay.event.id));
 assert.deepEqual(errors,['outbox_full']);assert.deepEqual(seen,[1]);assert.equal(sequencer.pendingItems,0);
 const report={reproduced:true,capacityFixture:1,productionCapacitySeparatelyTested:10000,existingEventDelivered:true,newEventDurablySaved:false,newEventStillInMemoryQueue:false,errorLogged:'outbox_full',sourceBoundaryMatchesWorker:true,limitation:'Uses the real outbox and sequencer modules with the same log-only rejection handling; does not run the whole production worker or send a real donation.'};
 await writeFile('../output/operations-20260909/overflow-path.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{const p=await realpath(directory);assert.equal(dirname(p),await realpath(root));await rm(p,{recursive:true,force:true})}
