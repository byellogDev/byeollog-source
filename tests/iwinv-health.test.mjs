import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const name of ['channel-health.test.py','monitor-recovery.test.py']){
 test(`iwinv health regression: ${name}`,()=>{
  const script=fileURLToPath(new URL('../operations/iwinv/'+name,import.meta.url));
  const result=spawnSync(process.env.PYTHON||'python',['-B',script],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
 });
}
