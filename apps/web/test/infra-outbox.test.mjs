import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedGatewayOutbox} from '../services/soop-chat-gateway/outbox.mjs';
const secret='isolated-infra-test-secret-with-at-least-32-characters';
const body=(workspace,sequence)=>({workspaceId:workspace,relay:{connection:{id:workspace,sequence},event:{message:'private fixture',eventId:String(sequence)}}});
async function fixture(run,options={}){const directory=await mkdtemp(join(tmpdir(),'infra-outbox-'));try{const box=new EncryptedGatewayOutbox({directory,secret,...options});await box.init();await run(box,directory)}finally{await rm(directory,{recursive:true,force:true})}}

test('slow channel cannot block another; same-channel FIFO and two-send limit hold',()=>fixture(async box=>{
 for(const w of ['slow','fast'])for(let i=0;i<4;i++)await box.enqueue(body(w,i));
 let release,fastDone;const gate=new Promise(r=>release=r),fastGate=new Promise(r=>fastDone=r);
 let active=0,peak=0;const seen={slow:[],fast:[]};
 const flushing=box.flush(async value=>{active++;peak=Math.max(peak,active);try{
   if(value.workspaceId==='slow'&&value.relay.connection.sequence===0)await gate;
   seen[value.workspaceId].push(value.relay.connection.sequence);
   if(seen.fast.length===4)fastDone();
 }finally{active--}},{concurrency:2});
 try{await Promise.race([fastGate,new Promise((_,reject)=>setTimeout(()=>reject(Error('fast blocked')),1500).unref())]);assert.deepEqual(seen.slow,[])}finally{release()}
 await flushing;assert.equal(peak,2);assert.deepEqual(seen,{slow:[0,1,2,3],fast:[0,1,2,3]});
}));
test('global capacity is atomic and duplicate at full capacity remains successful',()=>fixture(async box=>{
 const writes=await Promise.allSettled(Array.from({length:20},(_,i)=>box.enqueue(body('w'+i,0))));
 assert.equal(writes.filter(x=>x.status==='fulfilled').length,3);assert.equal(await box.count(),3);
 assert.equal((await box.enqueue(body('w0',0))).duplicate,true);
},{maxItems:3}));
test('backoff scans reuse metadata without caching private message bodies; tampering is still rejected',()=>fixture(async(box,directory)=>{
 for(let i=0;i<30;i++)await box.enqueue(body('w',i));
 await box.flush(async()=>{throw Object.assign(Error('offline'),{code:'offline'})});
 await box.flush(async()=>assert.fail('backoff must block'));
 let reads=0;const original=box.readFileName.bind(box);box.readFileName=async name=>{reads++;return original(name)};
 await box.flush(async()=>assert.fail('backoff must block'));assert.equal(reads,0);
 assert.ok([...box.metadataCache.values()].every(x=>!JSON.stringify(x).includes('private fixture')));
 const [name]=await box.files();const envelope=JSON.parse(await readFile(join(directory,name),'utf8'));envelope.ciphertext='AAAA';await writeFile(join(directory,name),JSON.stringify(envelope));
 let quarantined=0;await box.flush(async()=>assert.fail('backoff must block'),{onCorrupt:()=>quarantined++});assert.equal(quarantined,1);
},{baseRetryMs:60000}));
test('hourly retention uses creation date, preserving expired ciphertext in dead letter storage',()=>fixture(async(box,directory)=>{
 const item=await box.enqueue(body('old',0)),path=box.pathFor(item.id),envelope=JSON.parse(await readFile(path,'utf8'));
 envelope.createdAt=new Date(Date.now()-8*86400000).toISOString();await writeFile(path,JSON.stringify(envelope));box.lastPruneAt=0;
 const result=await box.flush(async()=>assert.fail('expired item sent'));assert.equal(result.pending,0);assert.equal(result.deadLetters,1);
 assert.doesNotMatch(await readFile(join(directory,(await box.deadFiles())[0]),'utf8'),/private fixture/);
}));
test('two-channel global batch limit holds and crash/restart recovery preserves every event',()=>fixture(async(box,directory)=>{
 for(let i=0;i<20;i++)await box.enqueue(body('w'+(i%3),Math.floor(i/3)));
 const sent=[];const result=await box.flush(async b=>sent.push(b),{concurrency:2,limit:3});assert.equal(sent.length,3);assert.equal(result.pending,17);
 const restarted=new EncryptedGatewayOutbox({directory,secret});await restarted.init();await restarted.flush(async b=>sent.push(b),{concurrency:2});
 assert.equal(sent.length,20);assert.equal(new Set(sent.map(b=>box.idFor(b))).size,20);
 for(let i=0;i<3;i++)assert.deepEqual(sent.filter(b=>b.workspaceId==='w'+i).map(b=>b.relay.connection.sequence),Array.from({length:i===2?6:7},(_,n)=>n));
}));
test('failed first-channel delivery preserves its followers while another channel drains',()=>fixture(async box=>{
 for(const w of ['bad','good'])for(let i=0;i<3;i++)await box.enqueue(body(w,i));
 const seen=[];await box.flush(async b=>{seen.push(b.workspaceId+b.relay.connection.sequence);if(b.workspaceId==='bad')throw Error('timeout')},{concurrency:2});
 assert.equal(seen.filter(x=>x.startsWith('bad')).length,1);assert.deepEqual(seen.filter(x=>x.startsWith('good')),['good0','good1','good2']);assert.equal(await box.count(),3);
}));
