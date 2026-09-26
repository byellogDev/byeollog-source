import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows PowerShell 5.1 parses and saves the Korean installer shortcut', {skip:process.platform!=='win32'}, async()=>{
  const source=await readFile(new URL('../apps/web/installer/Invoke-AgentInstall.ps1',import.meta.url));
  assert.equal(source.subarray(0,3).toString('hex'),'efbbbf','Windows PowerShell requires a UTF-8 BOM for Korean literals');
  const root=await mkdtemp(path.join(tmpdir(),'byeollog-shortcut-test-'));
  try {
    const runner=path.join(root,'check.ps1');
    await writeFile(runner,`param([string]$Source,[string]$Destination)
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$name=$ast.FindAll({param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $a.Value.EndsWith('.lnk')},$true)[0].Value
$expected=-join (@(48324,47197,32,54413,48317,51648,46,108,110,107)|ForEach-Object{[char]$_})
if($name -cne $expected){throw 'shortcut name corrupted'}
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut((Join-Path $Destination $name))
$link.TargetPath=Join-Path $env:WINDIR 'System32\\notepad.exe'
$link.Save()
if(!(Test-Path -LiteralPath (Join-Path $Destination $name))){throw 'shortcut was not saved'}
Write-Output 'shortcut-saved'
`, 'ascii');
    const run=filename=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',runner,'-Source',filename,'-Destination',root],{encoding:'utf8',windowsHide:true,timeout:20000});
    const broken=path.join(root,'without-bom.ps1');
    await writeFile(broken,source.subarray(3));
    assert.notEqual(run(broken).status,0,'the pre-fix encoding must reproduce the failure');
    const fixed=path.join(root,'with-bom.ps1');
    await writeFile(fixed,source);
    const result=run(fixed);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/shortcut-saved/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('byeollog-shortcut-test-'));
    await rm(root,{recursive:true,force:true});
  }
});
