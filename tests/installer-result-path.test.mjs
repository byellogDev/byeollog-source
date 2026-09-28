import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('installer receipt is UTF-8 with BOM for Inno Setup, including Unicode profile names',{skip:process.platform!=='win32'},async()=>{
 const file=new URL('../apps/web/installer/Invoke-AgentInstall.ps1',import.meta.url);
 const source=await readFile(file,'utf8');
 const writer=source.match(/\[IO\.File\]::WriteAllText\(\$ResultPath,\$installedExe,[^\r\n]+\)(?= \})/)?.[0];
 assert.ok(writer,'real installation must report its executable path');
 const root=await mkdtemp(path.join(tmpdir(),'byeollog-receipt-test-'));
 try{
  const script=path.join(root,'write.ps1'),receipt=path.join(root,'receipt.txt');
  const expected='C:\\Users\\한글 이름\\AppData\\Local\\Programs\\ByeollogCollector\\versions\\1.0.0.43\\byeollog.exe';
  await writeFile(script,'\ufeffparam([string]$ResultPath)\r\n$ErrorActionPreference="Stop"\r\n$installedExe=\''+expected+'\'\r\n'+writer+'\r\n');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,receipt],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const bytes=await readFile(receipt);
  assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf','UTF-16 cannot be consumed by LoadStringsFromFile');
  assert.equal(bytes.subarray(3).toString('utf8'),expected);
  assert.ok(!bytes.includes(0),'embedded UTF-16 NUL characters must not enter Inno path validation');
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('byeollog-receipt-test-'));
  await rm(root,{recursive:true,force:true});
 }
});
