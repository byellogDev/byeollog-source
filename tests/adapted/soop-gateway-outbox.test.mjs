import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedGatewayOutbox} from '../../services/soop-gateway/services/soop-chat-gateway/outbox.mjs';
import {WorkspaceEventSequencer} from '../../services/soop-gateway/services/soop-chat-gateway/workspace-event-sequencer.mjs';

const secret='outbox-test-secret-123456789012345678901234567890';
const payload={kind:'event',workspaceId:'workspace-1',relay:{eventType:'chat',event:{eventId:'e-1',actor:{id:'private-viewer',name:'비공개닉네임'},message:'비밀 채팅 문장'}}};

test('one workspace retry never blocks another beyond the flush limit; same-workspace order survives restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-isolation-'));
  try{
    const box=new EncryptedGatewayOutbox({directory,secret,baseRetryMs:60000,maxRetryMs:60000});await box.init();
    const item=(workspace,sequence)=>({...payload,workspaceId:workspace,relay:{...payload.relay,connection:{id:workspace,sequence},event:{...payload.relay.event,eventId:workspace+sequence}}});
    for(const sequence of [1,2,3])await box.enqueue(item('A',sequence));
    await new Promise(resolve=>setTimeout(resolve,5));
    await box.enqueue(item('B',1));
    const sent=[];
    const send=async body=>{sent.push(body.workspaceId+body.relay.connection.sequence);if(body.workspaceId==='A')throw Object.assign(Error('disabled'),{status:409})};
    const first=await box.flush(send,{limit:2});
    assert.deepEqual(sent,['A1','B1']);assert.equal(first.delivered,1);assert.equal(first.pending,3);
    const restarted=new EncryptedGatewayOutbox({directory,secret});await restarted.init();
    await restarted.enqueue(item('C',1));
    await restarted.flush(send,{limit:1});
    assert.deepEqual(sent,['A1','B1','C1']);
    // Only the backoff timestamp is advanced in this isolated fixture.
    for(const {name,item:queued} of await restarted.orderedItems()){
      const envelope={...queued.envelope,delivery:{...queued.envelope.delivery,nextAttemptAt:null}};
      await restarted.writeEnvelope(join(directory,name),envelope);
    }
    const recovered=[];await restarted.flush(async body=>recovered.push(body.workspaceId+body.relay.connection.sequence));
    assert.deepEqual(recovered,['A1','A2','A3']);assert.equal(await restarted.count(),0);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('encrypted outbox survives restart, hides content, deduplicates, and retries',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-test-'));
  try{
    const first=new EncryptedGatewayOutbox({directory,secret,baseRetryMs:1,maxRetryMs:1});await first.init();
    assert.equal((await first.enqueue(payload)).duplicate,false);
    assert.equal((await first.enqueue(payload)).duplicate,true);
    const names=await first.files();assert.equal(names.length,1);
    const disk=await readFile(join(directory,names[0]),'utf8');
    assert.doesNotMatch(disk,/private-viewer|비공개닉네임|비밀 채팅 문장/);
    const failed=await first.flush(async()=>{throw Object.assign(new Error('offline'),{code:'network_offline'})});
    assert.equal(failed.pending,1);
    await new Promise(resolve=>setTimeout(resolve,10));
    const second=new EncryptedGatewayOutbox({directory,secret,baseRetryMs:1,maxRetryMs:1});await second.init();
    const delivered=[];const recovered=await second.flush(async body=>delivered.push(body));
    assert.equal(recovered.delivered,1);assert.equal(recovered.pending,0);assert.deepEqual(delivered,[payload]);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('a poison event is dead-lettered after bounded permanent failures and does not block later events',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-dlq-'));
  try{
    const outbox=new EncryptedGatewayOutbox({directory,secret,baseRetryMs:1,maxRetryMs:1,permanentFailureAttempts:3});
    await outbox.init();
    const poison={...payload,relay:{...payload.relay,event:{...payload.relay.event,eventId:'poison'}}};
    const healthy={...payload,relay:{...payload.relay,event:{...payload.relay.event,eventId:'healthy'}}};
    const poisonId=(await outbox.enqueue(poison)).id;
    await outbox.enqueue(healthy);
    const delivered=[];
    const send=async body=>{
      if(outbox.idFor(body)===poisonId)throw Object.assign(new Error('invalid payload'),{status:400,code:'invalid_payload'});
      delivered.push(body);
    };
    const classifyFailure=error=>({retryable:error.status!==400});
    for(let attempt=0;attempt<3;attempt+=1){
      await outbox.flush(send,{classifyFailure});
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const status=await outbox.status();
    assert.equal(status.pending,0);assert.equal(status.deadLetters,1);
    assert.deepEqual(delivered,[healthy]);
    const dead=await readFile(join(directory,(await outbox.deadFiles())[0]),'utf8');
    assert.doesNotMatch(dead,/private-viewer|비공개닉네임|비밀 채팅 문장/);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('tampered outbox entries are quarantined and never delivered',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-tamper-'));
  try{
    const outbox=new EncryptedGatewayOutbox({directory,secret});await outbox.init();await outbox.enqueue(payload);
    const [name]=await outbox.files();const envelope=JSON.parse(await readFile(join(directory,name),'utf8'));envelope.ciphertext='AAAA';
    await import('node:fs/promises').then(fs=>fs.writeFile(join(directory,name),JSON.stringify(envelope),'utf8'));
    let delivered=false,corrupt=false;const result=await outbox.flush(async()=>{delivered=true},{onCorrupt:()=>{corrupt=true}});
    assert.equal(delivered,false);assert.equal(corrupt,true);assert.equal(result.pending,0);
    assert.equal((await readdir(directory)).some(value=>value.includes('.corrupt-')),true);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('gateway events are delivered in SDK sequence order instead of hash filename order',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-order-'));
  try{
    const outbox=new EncryptedGatewayOutbox({directory,secret});await outbox.init();
    const withSequence=sequence=>({...payload,relay:{...payload.relay,
      connection:{id:'workspace-connection-1',sequence,reconnectCount:0},
      event:{...payload.relay.event,eventId:`event-${sequence}`}}});
    await outbox.enqueue(withSequence(2));
    await outbox.enqueue(withSequence(1));
    const delivered=[];
    await outbox.flush(async body=>delivered.push(body.relay.connection.sequence));
    assert.deepEqual(delivered,[1,2]);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('per-workspace sequencing publishes a delayed first event before an immediate second flush',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-race-'));
  try{
    const outbox=new EncryptedGatewayOutbox({directory,secret});await outbox.init();
    const sequencer=new WorkspaceEventSequencer();
    const withSequence=sequence=>({...payload,workspaceId:'workspace-1',relay:{...payload.relay,
      connection:{id:'workspace-connection-1',sequence,reconnectCount:0},
      event:{...payload.relay.event,eventId:`race-event-${sequence}`}}});
    const firstBody=withSequence(1),firstId=outbox.idFor(firstBody);
    const writeEnvelope=outbox.writeEnvelope.bind(outbox);
    outbox.writeEnvelope=async(destination,envelope,options)=>{
      if(envelope.id===firstId&&Number(envelope.delivery?.attempts)===0){
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      return await writeEnvelope(destination,envelope,options);
    };
    const delivered=[];
    const publish=body=>sequencer.run(body.workspaceId,async()=>{
      await outbox.enqueue(body);
      void outbox.flush(async value=>delivered.push(value.relay.connection.sequence));
    });
    await Promise.all([publish(firstBody),publish(withSequence(2))]);
    for(let attempt=0;attempt<3&&(await outbox.status()).pending>0;attempt+=1){
      await outbox.flush(async value=>delivered.push(value.relay.connection.sequence));
    }
    await sequencer.drain();
    assert.deepEqual(delivered,[1,2]);
    assert.equal(sequencer.pendingWorkspaces,0);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('a delayed workspace tail does not block another workspace and failures do not poison the queue',async()=>{
  const sequencer=new WorkspaceEventSequencer();
  let releaseSlow;
  const slowGate=new Promise(resolve=>{releaseSlow=resolve});
  const slow=sequencer.run('slow',async()=>{await slowGate});
  let fastCompleted=false;
  await sequencer.run('fast',async()=>{fastCompleted=true});
  assert.equal(fastCompleted,true);
  await assert.rejects(sequencer.run('recover',async()=>{throw new Error('expected failure')}));
  let recovered=false;
  await sequencer.run('recover',async()=>{recovered=true});
  assert.equal(recovered,true);
  releaseSlow();await slow;await sequencer.drain();
  assert.equal(sequencer.pendingWorkspaces,0);
});

test('drain includes work appended while shutdown is waiting for the current workspace tail',async()=>{
  const sequencer=new WorkspaceEventSequencer();
  let releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve});
  let firstStarted;
  const started=new Promise(resolve=>{firstStarted=resolve});
  void sequencer.run('workspace-shutdown',async()=>{firstStarted();await firstGate});
  await started;
  const draining=sequencer.drain();
  let secondCompleted=false;
  void sequencer.run('workspace-shutdown',async()=>{secondCompleted=true});
  releaseFirst();
  await draining;
  assert.equal(secondCompleted,true);
  assert.equal(sequencer.pendingWorkspaces,0);
});
