import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('supervisor records child failure and restarts it without manual control',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'byeollog-supervisor-test-'));
  await mkdir(join(directory,'services/soop-chat-gateway'),{recursive:true});
  await mkdir(join(directory,'test/fixtures'),{recursive:true});
  await copyFile(resolve('BYEOLLOG_STABILITY_AUDIT_20260923/components/ncp-gateway/services/soop-chat-gateway/supervisor.mjs'),join(directory,'services/soop-chat-gateway/supervisor.mjs'));
  await copyFile(resolve('BYEOLLOG_STABILITY_AUDIT_20260923/components/frontend/test/fixtures/soop-gateway-exit-once.mjs'),join(directory,'test/fixtures/soop-gateway-exit-once.mjs'));
  const supervisor=spawn(process.execPath,['services/soop-chat-gateway/supervisor.mjs'],{
    cwd:directory,windowsHide:true,
    env:{...process.env,SOOP_GATEWAY_STATE_DIR:directory,SOOP_GATEWAY_SUPERVISOR_SELF_TEST:'true',SOOP_GATEWAY_SELF_TEST_ENTRY:join(directory,'test/fixtures/soop-gateway-exit-once.mjs'),SOOP_GATEWAY_RESTART_BASE_MS:'50',SOOP_GATEWAY_RESTART_MAX_MS:'100',SOOP_GATEWAY_HEALTH_PORT:'0'},
    stdio:['ignore','pipe','pipe']
  });
  let output='';supervisor.stdout.on('data',chunk=>{output+=chunk});supervisor.stderr.on('data',chunk=>{output+=chunk});
  try{
    const deadline=Date.now()+5_000;
    while(Date.now()<deadline&&!/"gateway_child_started"[^\n]*"restartCount":1/.test(output))await new Promise(resolveWait=>setTimeout(resolveWait,50));
    assert.match(output,/"gateway_child_exited"/);assert.match(output,/"code":27/);assert.match(output,/"restartCount":1/);
    const state=JSON.parse(await readFile(join(directory,'supervisor-state.json'),'utf8'));
    assert.equal(state.status,'running');assert.equal(state.restartCount,1);assert.ok(Number(state.childPid)>0);
  }finally{
    supervisor.kill('SIGTERM');await Promise.race([new Promise(resolveExit=>supervisor.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,2_000))]);
    if(supervisor.exitCode===null)supervisor.kill('SIGKILL');await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
