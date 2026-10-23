import {EncryptedGatewayOutbox} from '../../services/soop-gateway/services/soop-chat-gateway/outbox.mjs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../.local/soop-browserless-lab/',import.meta.url));
const secret='synthetic-lab-key-not-a-production-credential';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const reports=[];
for(const delay of [100,500]){
  const directory=await mkdtemp(root+'outbox-'),config={directory,secret,baseRetryMs:1,maxRetryMs:1};
  let q=new EncryptedGatewayOutbox(config);await q.init();
  const bodies=Array.from({length:200},(_,i)=>({workspaceId:`synthetic-${i%100}`,relay:{connection:{id:'run',sequence:Math.floor(i/100)+1},event:{id:`event-${i}`}}}));
  const start=performance.now();for(const b of bodies)await q.enqueue(b);const enqueueMs=performance.now()-start;
  const duplicate=await q.enqueue(bodies[0]);assert.equal(duplicate.duplicate,true);assert.equal(await q.count(),200);
  // Reopen the ciphertext queue using a new object: restart read-path, not a kill test.
  q=new EncryptedGatewayOutbox(config);await q.init();
  const seen=new Set(),lastSequence=new Map();let maxInFlight=0,inFlight=0;
  const send=async body=>{
    inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await sleep(delay);inFlight--;
    const {sequence}=body.relay.connection;assert.equal(sequence,(lastSequence.get(body.workspaceId)||0)+1);
    lastSequence.set(body.workspaceId,sequence);assert.equal(seen.has(body.relay.event.id),false);seen.add(body.relay.event.id);
  };
  const drainStart=performance.now();const result=await q.flush(send,{concurrency:2,limit:250});const drainMs=performance.now()-drainStart;
  assert.equal(result.delivered,200);assert.equal(result.pending,0);assert.equal(seen.size,200);assert.equal(maxInFlight,2);
  const report={apiDelayMs:delay,events:200,workspaces:100,enqueueMs,drainMs,deliveredPerSecond:200/(drainMs/1000),maxInFlight,duplicateEnqueueSuppressed:true,reopenedFromDisk:true,perWorkspaceOrder:true,...result};reports.push(report);console.log(JSON.stringify(report));
}
// Lost HTTP acknowledgment requires receiver idempotency. Simulate that explicitly.
const directory=await mkdtemp(root+'ack-loss-'),cfg={directory,secret,baseRetryMs:1,maxRetryMs:1};
let q=new EncryptedGatewayOutbox(cfg);await q.init();
const body={workspaceId:'synthetic-ack',relay:{connection:{id:'ack',sequence:1},event:{id:'only-once'}}};await q.enqueue(body);
const applied=new Set();let calls=0;
const send=async b=>{calls++;applied.add(b.relay.event.id);if(calls===1)throw Object.assign(Error('synthetic acknowledgment loss'),{code:'timeout'})};
const first=await q.flush(send,{concurrency:2});assert.equal(first.pending,1);
q=new EncryptedGatewayOutbox(cfg);await q.init();await sleep(20);const second=await q.flush(send,{concurrency:2});
assert.equal(second.pending,0);assert.equal(calls,2);assert.equal(applied.size,1);
const ackLoss={calls,simulatedReceiverApplications:applied.size,first,second,scope:'Receiver idempotency is a fixture; not a production DB test.'};
console.log(JSON.stringify({ackLoss}));
await writeFile(root+'outbox-result.json',JSON.stringify({at:new Date().toISOString(),node:process.version,scope:'Actual canonical encrypted outbox, local files, synthetic delay/receiver; no production API/DB traffic.',reports,ackLoss},null,2));
