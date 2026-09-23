import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../apps/admin-runtime/handlers/backups.js';
test('operator backup targets, workspace mirror, and cleanup reject missing and wrong secrets without DB calls',async()=>{
 const original=process.env.CRON_SECRET,fetch=globalThis.fetch;process.env.CRON_SECRET='test-backup-cron-secret-1234567890';
 globalThis.fetch=()=>assert.fail('unauthorized request reached database');
 try{for(const cron of ['targets','workspace','cleanup','retention-list','retention-file'])for(const authorization of ['', 'Bearer wrong',...(cron==='cleanup'?[]:['Bearer test-backup-cron-secret-1234567890'])]){
   const response={setHeader(){},status(code){this.code=code;return this},json(value){this.body=value;return this}};
   await handler({method:['workspace','retention-file'].includes(cron)?'POST':'GET',query:{cron},headers:{authorization},body:{}},response);
   assert.equal(response.code,401);assert.equal(response.body.message,'Unauthorized');
 }}finally{globalThis.fetch=fetch;if(original===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=original}
});

test('backup recipient fails closed and cannot be overridden by the caller',async()=>{
 const before={secret:process.env.BYEOLLOG_BACKUP_RUNNER_SECRET,key:process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY,fetch:globalThis.fetch};
 process.env.BYEOLLOG_BACKUP_RUNNER_SECRET='dedicated-test-key';
 globalThis.fetch=()=>assert.fail('invalid recipient reached database');
 try{
  for(const [key,expected] of [[undefined,503],['fixed-server-recipient',400]]){
   if(key===undefined)delete process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY;else process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY=key;
   const res={setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}};
   await handler({method:'POST',query:{cron:'workspace'},headers:{authorization:'Bearer dedicated-test-key'},body:{workspaceId:'test',publicKey:'attacker-recipient'}},res);
   assert.equal(res.code,expected);
  }
 }finally{
  globalThis.fetch=before.fetch;
  for(const [name,value] of [['BYEOLLOG_BACKUP_RUNNER_SECRET',before.secret],['BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY',before.key]])if(value===undefined)delete process.env[name];else process.env[name]=value;
 }
});
