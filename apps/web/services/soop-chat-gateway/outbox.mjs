import crypto from 'node:crypto';
import {link,mkdir,readFile,readdir,rename,rm,stat,statfs,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const VERSION=1;

function deriveKey(secret){
  return crypto.createHash('sha256').update('byeollog-soop-gateway-outbox-v1\0').update(String(secret)).digest();
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class EncryptedGatewayOutbox{
  constructor({directory,secret,maxItems=10_000,maxAgeMs=7*24*60*60*1_000,
    deadLetterMaxAgeMs=30*24*60*60*1_000,baseRetryMs=1_000,maxRetryMs=5*60*1_000,
    permanentFailureAttempts=3,reserveItems=0,reserveFreeBytes=256*1024*1024}={}){
    if(!directory)throw new Error('Outbox directory is required');
    if(String(secret||'').length<32)throw new Error('Outbox secret must be at least 32 characters');
    this.directory=directory;this.key=deriveKey(secret);this.maxItems=maxItems;this.maxAgeMs=maxAgeMs;
    if(!Number.isSafeInteger(reserveItems)||reserveItems<0||reserveItems>10000)throw new Error('Invalid outbox reserve capacity');
    this.reserveItems=reserveItems;this.reserveFreeBytes=reserveFreeBytes;
    this.deadLetterMaxAgeMs=deadLetterMaxAgeMs;this.baseRetryMs=baseRetryMs;this.maxRetryMs=maxRetryMs;
    this.permanentFailureAttempts=permanentFailureAttempts;this.flushPromise=null;
    this.enqueueTail=Promise.resolve();this.metadataCache=new Map();this.lastPruneAt=0;
  }
  async init(){await mkdir(this.directory,{recursive:true});return await this.pruneExpired()}
  idFor(body){return crypto.createHmac('sha256',this.key).update(stableJson(body)).digest('hex')}
  pathFor(id){return join(this.directory,`${id}.json`)}
  async entries(pattern){return (await readdir(this.directory,{withFileTypes:true})).filter(entry=>entry.isFile()&&pattern.test(entry.name)).map(entry=>entry.name).sort()}
  async files(){return await this.entries(/^[a-f0-9]{64}\.json$/)}
  async deadFiles(){return await this.entries(/^[a-f0-9]{64}\.dead-[0-9]+\.json$/)}
  async writeEnvelope(destination,envelope,{exclusive=false}={}){
    const temporary=join(this.directory,`.${envelope.id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary,JSON.stringify(envelope),{encoding:'utf8',mode:0o600});
    try{
      if(exclusive){await link(temporary,destination);await rm(temporary,{force:true})}
      else await rename(temporary,destination);
    }catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error}
  }
  enqueue(body){
    // Serialize the capacity check across channels without putting network I/O
    // under this lock. A rejected write must not poison subsequent writes.
    const next=this.enqueueTail.then(()=>this.enqueueOne(body));
    this.enqueueTail=next.catch(()=>{});return next;
  }
  async enqueueOne(body){
    const plaintext=Buffer.from(stableJson(body),'utf8'),id=this.idFor(body),destination=this.pathFor(id);
    try{await stat(destination);return {id,duplicate:true}}catch(error){if(error?.code!=='ENOENT')throw error}
    const files=await this.files();
    if(files.length>=this.maxItems+this.reserveItems)throw Object.assign(new Error('Encrypted gateway outbox is full'),{code:'outbox_full'});
    const capacityReserve=files.length>=this.maxItems;
    if(capacityReserve){
      // Reserved ciphertext uses the SAME v1 files and FIFO, including rollback.
      // Never consume the host's final disk reserve while extending the queue.
      const disk=await statfs(this.directory);
      if(Number(disk.bavail)*Number(disk.bsize)<this.reserveFreeBytes+plaintext.length*2+4096){
        throw Object.assign(new Error('Encrypted gateway outbox disk reserve reached'),{code:'outbox_disk_reserve'});
      }
    }
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`byeollog-soop-outbox:${VERSION}:${id}`));
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag();
    const envelope={version:VERSION,id,createdAt:new Date().toISOString(),iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64'),delivery:{attempts:0,nextAttemptAt:null,lastErrorCode:null,lastStatus:null}};
    try{await this.writeEnvelope(destination,envelope,{exclusive:true})}catch(error){if(error?.code!=='EEXIST')throw error;return {id,duplicate:true}}
    return {id,duplicate:false,...(capacityReserve?{capacityReserve:true}:{})};
  }
  async readFileName(name){
    const envelope=JSON.parse(await readFile(join(this.directory,name),'utf8'));
    const id=name.slice(0,-5);
    if(envelope.version!==VERSION||envelope.id!==id)throw Object.assign(new Error('Outbox envelope mismatch'),{code:'outbox_envelope_invalid'});
    const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(Buffer.from(`byeollog-soop-outbox:${VERSION}:${id}`));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
    const body=JSON.parse(plaintext.toString('utf8'));
    if(this.idFor(body)!==id)throw Object.assign(new Error('Outbox payload hash mismatch'),{code:'outbox_payload_invalid'});
    const delivery=envelope.delivery&&typeof envelope.delivery==='object'?envelope.delivery:{};
    return {id,body,createdAt:envelope.createdAt,envelope,delivery:{
      attempts:Math.max(0,Math.trunc(Number(delivery.attempts)||0)),
      nextAttemptAt:delivery.nextAttemptAt||null,lastErrorCode:delivery.lastErrorCode||null,
      lastStatus:Number(delivery.lastStatus)||null
    }};
  }
  async remove(id){await rm(this.pathFor(id),{force:true});this.metadataCache.delete(`${id}.json`)}
  async quarantine(name){
    this.metadataCache.delete(name);
    const source=join(this.directory,name),destination=join(this.directory,`${name}.corrupt-${Date.now()}`);
    await rename(source,destination).catch(()=>{});
  }
  async defer(name,item,error,now=Date.now()){
    const attempts=item.delivery.attempts+1;
    const exponential=Math.min(this.maxRetryMs,this.baseRetryMs*(2**Math.min(16,attempts-1)));
    const jitter=Number.parseInt(item.id.slice(0,6),16)%Math.max(1,Math.ceil(exponential*0.2));
    const nextAttemptAt=new Date(now+exponential+jitter).toISOString();
    const envelope={...item.envelope,delivery:{attempts,nextAttemptAt,
      lastErrorCode:String(error?.code||'delivery_failed').slice(0,120),lastStatus:Number(error?.status)||null}};
    await this.writeEnvelope(join(this.directory,name),envelope);
    this.metadataCache.delete(name);
    return {attempts,nextAttemptAt};
  }
  async deadLetter(name,item,error,now=Date.now()){
    const attempts=item.delivery.attempts+1;
    const envelope={...item.envelope,delivery:{attempts,nextAttemptAt:null,
      lastErrorCode:String(error?.code||'delivery_failed').slice(0,120),lastStatus:Number(error?.status)||null,
      deadLetteredAt:new Date(now).toISOString()}};
    const destination=join(this.directory,`${item.id}.dead-${now}.json`);
    await this.writeEnvelope(destination,envelope);
    await rm(join(this.directory,name),{force:true});
    this.metadataCache.delete(name);
    return {attempts,destination};
  }
  async pruneExpired(now=Date.now()){
    let pendingExpired=0,deadRemoved=0,corrupt=0;
    for(const name of await this.files()){
      try{
        const info=await stat(join(this.directory,name));
        const item=await this.readFileName(name);
        const created=Date.parse(item.createdAt);
        if(now-(Number.isFinite(created)?created:info.mtimeMs)<=this.maxAgeMs)continue;
        const error=Object.assign(new Error('Gateway outbox item exceeded its online retention window'),{code:'outbox_expired'});
        await this.deadLetter(name,item,error,now);pendingExpired+=1;
      }catch{await this.quarantine(name);corrupt+=1}
    }
    for(const name of await this.deadFiles()){
      try{const info=await stat(join(this.directory,name));if(now-info.mtimeMs>this.deadLetterMaxAgeMs){await rm(join(this.directory,name),{force:true});deadRemoved+=1}}catch{}
    }
    this.lastPruneAt=now;
    return {pendingExpired,deadRemoved,corrupt};
  }
  async count(){return (await this.files()).length}
  async status(){return {pending:await this.count(),deadLetters:(await this.deadFiles()).length,maxItems:this.maxItems}}
  async deliveryIndex(){
    // Cache scheduling metadata only, never donor/chat bodies. Always decrypt
    // the disk envelope again immediately before sending it. Restarts rebuild
    // this disposable index from the existing encrypted v1 files.
    const names=await this.files(),present=new Set(names),items=[];
    for(const name of this.metadataCache.keys())if(!present.has(name))this.metadataCache.delete(name);
    for(const name of names){
      try{
        const info=await stat(join(this.directory,name));
        const fingerprint=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        let entry=this.metadataCache.get(name);
        if(entry?.fingerprint!==fingerprint){
          const item=await this.readFileName(name),connection=item.body?.relay?.connection;
          entry={name,fingerprint,id:item.id,createdAt:item.createdAt,
            workspace:crypto.createHmac('sha256',this.key).update(String(item.body?.workspaceId||'unknown-workspace')).digest('hex'),
            connection:connection?.id?crypto.createHmac('sha256',this.key).update(String(connection.id)).digest('hex'):null,
            sequence:Number(connection?.sequence),nextAttemptAt:item.delivery.nextAttemptAt};
          this.metadataCache.set(name,entry);
        }
        items.push(entry);
      }catch(error){if(error?.code!=='ENOENT'){await this.quarantine(name);items.push({name,error})}}
    }
    return items.sort((a,b)=>{
      if(a.error||b.error)return a.error?(b.error?a.name.localeCompare(b.name):1):-1;
      if(a.workspace===b.workspace&&a.connection&&a.connection===b.connection){
        const difference=a.sequence-b.sequence;if(Number.isFinite(difference)&&difference!==0)return difference;
      }
      return String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id);
    });
  }
  async diagnostics(){
    const entries=(await this.deliveryIndex()).filter(x=>!x.error),now=Date.now(),channels=new Map();
    for(const entry of entries){
      const channel=channels.get(entry.workspace)||{workspace:entry.workspace.slice(0,12),pending:0,oldestAgeMs:0};
      channel.pending++;channel.oldestAgeMs=Math.max(channel.oldestAgeMs,Math.max(0,now-(Date.parse(entry.createdAt)||now)));channels.set(entry.workspace,channel);
    }
    return {...await this.status(),oldestAgeMs:Math.max(0,...[...channels.values()].map(x=>x.oldestAgeMs)),channels:[...channels.values()]};
  }
  async orderedItems(){
    const items=[];
    for(const name of await this.files()){
      try{items.push({name,item:await this.readFileName(name)})}
      catch(error){await this.quarantine(name);items.push({name,item:null,error})}
    }
    return items.sort((left,right)=>{
      if(!left.item||!right.item)return left.item?-1:right.item?1:left.name.localeCompare(right.name);
      const a=left.item.body?.relay?.connection,b=right.item.body?.relay?.connection;
      if(left.item.body?.workspaceId===right.item.body?.workspaceId&&a?.id&&a.id===b?.id){
        const sequenceDifference=Number(a.sequence)-Number(b.sequence);
        if(Number.isFinite(sequenceDifference)&&sequenceDifference!==0)return sequenceDifference;
      }
      return String(left.item.createdAt).localeCompare(String(right.item.createdAt))||left.item.id.localeCompare(right.item.id);
    });
  }
  async flush(send,{limit=250,onCorrupt=()=>{},onFailure=()=>{},onDelivered=()=>{},onDeadLetter=()=>{},
    classifyFailure=()=>({retryable:true}),concurrency=1}={}){
    if(this.flushPromise)return await this.flushPromise;
    this.flushPromise=(async()=>{
      let delivered=0,deferred=0,deadLettered=0,attempted=0;
      if(Date.now()-this.lastPruneAt>=60*60*1000)await this.pruneExpired();
      const blockedWorkspaces=new Set(),active=new Set(),entries=await this.deliveryIndex();
      for(const entry of entries)if(entry.error)onCorrupt(entry.error);
      const pending=entries.filter(entry=>!entry.error);
      const take=()=>{
        if(attempted>=limit)return null;
        const index=pending.findIndex(entry=>!blockedWorkspaces.has(entry.workspace)&&!active.has(entry.workspace));
        if(index<0)return null;
        const [entry]=pending.splice(index,1);active.add(entry.workspace);return entry;
      };
      const run=async()=>{let entry;while((entry=take())){
        const {name,workspace}=entry;
        try{
        const nextAttemptAt=Date.parse(entry.nextAttemptAt||'');
        if(Number.isFinite(nextAttemptAt)&&nextAttemptAt>Date.now()){
          blockedWorkspaces.add(workspace);continue;
        }
        let item;
        try{item=await this.readFileName(name)}catch(error){await this.quarantine(name);onCorrupt(error);blockedWorkspaces.add(workspace);continue}
        // Another runner may have claimed the final global slot during disk I/O.
        if(attempted>=limit)return;
        attempted+=1;
        try{await send(item.body)}catch(error){
          const classification=classifyFailure(error,item)||{retryable:true};
          const permanent=classification.retryable===false;
          if(permanent&&item.delivery.attempts+1>=this.permanentFailureAttempts){
            const state=await this.deadLetter(name,item,error);deadLettered+=1;
            onDeadLetter(error,item,{...classification,...state});continue;
          }
          const state=await this.defer(name,item,error);deferred+=1;
          onFailure(error,item,{...classification,...state});
          blockedWorkspaces.add(workspace);continue;
        }
        await this.remove(item.id);delivered+=1;onDelivered(item);
        }finally{active.delete(workspace)}
      }};
      const results=await Promise.allSettled(Array.from({length:Math.max(1,Math.min(4,Math.trunc(Number(concurrency)||1)))},run));
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      return {delivered,deferred,deadLettered,pending:await this.count(),deadLetters:(await this.deadFiles()).length};
    })();
    try{return await this.flushPromise}finally{this.flushPromise=null}
  }
}
