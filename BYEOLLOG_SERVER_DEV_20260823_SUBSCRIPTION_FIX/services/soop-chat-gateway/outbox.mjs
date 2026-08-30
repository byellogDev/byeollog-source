import crypto from 'node:crypto';
import {mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
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
  constructor({directory,secret,maxItems=10_000,maxAgeMs=7*24*60*60*1_000}={}){
    if(!directory)throw new Error('Outbox directory is required');
    if(String(secret||'').length<32)throw new Error('Outbox secret must be at least 32 characters');
    this.directory=directory;this.key=deriveKey(secret);this.maxItems=maxItems;this.maxAgeMs=maxAgeMs;this.flushPromise=null;
  }
  async init(){await mkdir(this.directory,{recursive:true});await this.pruneExpired()}
  idFor(body){return crypto.createHmac('sha256',this.key).update(stableJson(body)).digest('hex')}
  pathFor(id){return join(this.directory,`${id}.json`)}
  async files(){return (await readdir(this.directory,{withFileTypes:true})).filter(entry=>entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name)).map(entry=>entry.name).sort()}
  async enqueue(body){
    const files=await this.files();
    if(files.length>=this.maxItems)throw Object.assign(new Error('Encrypted gateway outbox is full'),{code:'outbox_full'});
    const plaintext=Buffer.from(stableJson(body),'utf8'),id=this.idFor(body),destination=this.pathFor(id);
    try{await stat(destination);return {id,duplicate:true}}catch(error){if(error?.code!=='ENOENT')throw error}
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`byeollog-soop-outbox:${VERSION}:${id}`));
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag();
    const envelope={version:VERSION,id,createdAt:new Date().toISOString(),iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64')};
    const temporary=join(this.directory,`.${id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary,JSON.stringify(envelope),{encoding:'utf8',mode:0o600});
    try{await rename(temporary,destination)}catch(error){await rm(temporary,{force:true}).catch(()=>{});if(error?.code!=='EEXIST')throw error;return {id,duplicate:true}}
    return {id,duplicate:false};
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
    return {id,body,createdAt:envelope.createdAt};
  }
  async remove(id){await rm(this.pathFor(id),{force:true})}
  async quarantine(name){
    const source=join(this.directory,name),destination=join(this.directory,`${name}.corrupt-${Date.now()}`);
    await rename(source,destination).catch(()=>{});
  }
  async pruneExpired(now=Date.now()){
    let removed=0;
    for(const name of await this.files()){
      try{const info=await stat(join(this.directory,name));if(now-info.mtimeMs>this.maxAgeMs){await rm(join(this.directory,name),{force:true});removed+=1}}catch{}
    }
    return removed;
  }
  async count(){return (await this.files()).length}
  async flush(send,{limit=250,onCorrupt=()=>{},onFailure=()=>{},onDelivered=()=>{}}={}){
    if(this.flushPromise)return await this.flushPromise;
    this.flushPromise=(async()=>{
      let delivered=0;
      for(const name of (await this.files()).slice(0,limit)){
        let item;
        try{item=await this.readFileName(name)}catch(error){await this.quarantine(name);onCorrupt(error);continue}
        try{await send(item.body)}catch(error){onFailure(error,item);break}
        await this.remove(item.id);delivered+=1;onDelivered(item);
      }
      return {delivered,pending:await this.count()};
    })();
    try{return await this.flushPromise}finally{this.flushPromise=null}
  }
}
