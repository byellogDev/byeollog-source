import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedGatewayOutbox} from '../services/soop-chat-gateway/outbox.mjs';

const secret='outbox-test-secret-123456789012345678901234567890';
const payload={kind:'event',workspaceId:'workspace-1',relay:{eventType:'chat',event:{eventId:'e-1',actor:{id:'private-viewer',name:'비공개닉네임'},message:'비밀 채팅 문장'}}};

test('encrypted outbox survives restart, hides content, deduplicates, and retries',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-outbox-test-'));
  try{
    const first=new EncryptedGatewayOutbox({directory,secret});await first.init();
    assert.equal((await first.enqueue(payload)).duplicate,false);
    assert.equal((await first.enqueue(payload)).duplicate,true);
    const names=await first.files();assert.equal(names.length,1);
    const disk=await readFile(join(directory,names[0]),'utf8');
    assert.doesNotMatch(disk,/private-viewer|비공개닉네임|비밀 채팅 문장/);
    const failed=await first.flush(async()=>{throw Object.assign(new Error('offline'),{code:'network_offline'})});
    assert.equal(failed.pending,1);
    const second=new EncryptedGatewayOutbox({directory,secret});await second.init();
    const delivered=[];const recovered=await second.flush(async body=>delivered.push(body));
    assert.equal(recovered.delivered,1);assert.equal(recovered.pending,0);assert.deepEqual(delivered,[payload]);
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
