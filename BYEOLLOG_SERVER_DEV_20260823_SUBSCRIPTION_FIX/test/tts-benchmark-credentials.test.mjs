import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const save=await readFile(new URL('../tools/Save-TtsBenchmarkCredentials.ps1',import.meta.url),'utf8');
const run=await readFile(new URL('../tools/Run-ManagedTtsBenchmark.ps1',import.meta.url),'utf8');
const saveInworld=await readFile(new URL('../tools/Save-InworldTtsBenchmarkCredential.ps1',import.meta.url),'utf8');
const runInworld=await readFile(new URL('../tools/Run-InworldTtsBenchmark.ps1',import.meta.url),'utf8');
const saveCartesia=await readFile(new URL('../tools/Save-CartesiaTtsBenchmarkCredential.ps1',import.meta.url),'utf8');
const runCartesia=await readFile(new URL('../tools/Run-CartesiaVoiceBenchmark.ps1',import.meta.url),'utf8');
const runCartesiaFallback=await readFile(new URL('../tools/Run-CartesiaFallbackBenchmark.ps1',import.meta.url),'utf8');

test('managed TTS credentials are DPAPI protected and never printed',()=>{
  assert.match(save,/Read-Host \$Prompt -AsSecureString/);
  assert.match(save,/ConvertFrom-SecureString/);
  assert.match(save,/icacls\.exe/);
  assert.doesNotMatch(save,/Write-(?:Host|Output).*ApiKey/i);
});

test('Inworld credentials are protected and cleared after benchmarking',()=>{
  assert.match(saveInworld,/Read-Host "Inworld Basic \(Base64\) API Key" -AsSecureString/);
  assert.match(saveInworld,/ConvertFrom-SecureString/);
  assert.match(saveInworld,/voices\/v1\/voices\?languages=KO_KR/);
  assert.doesNotMatch(saveInworld,/Write-(?:Host|Output).*plainApiKey/i);
  assert.match(runInworld,/Read-DpapiSecret/);
  assert.match(runInworld,/ZeroFreeBSTR/);
  assert.match(runInworld,/finally\s*\{[\s\S]*Remove-Item Env:INWORLD_API_KEY/);
});

test('managed TTS benchmark clears provider credentials after the child process',()=>{
  assert.match(run,/Read-DpapiSecret/);
  assert.match(run,/ZeroFreeBSTR/);
  assert.match(run,/finally\s*\{[\s\S]*Remove-Item Env:CARTESIA_API_KEY/);
  assert.match(run,/--allow-remote/);
});

test('Cartesia credential is DPAPI protected and the Korean voice catalog contains no API key',()=>{
  assert.match(saveCartesia,/Read-Host "Cartesia API Key" -AsSecureString/);
  assert.match(saveCartesia,/ConvertFrom-SecureString/);
  assert.match(saveCartesia,/voices\?language=ko&limit=100/);
  assert.match(saveCartesia,/Authorization = "Bearer \$plainApiKey"/);
  assert.match(saveCartesia,/icacls\.exe/);
  assert.match(saveCartesia,/Remove-Variable plainApiKey/);
  assert.doesNotMatch(saveCartesia,/Write-(?:Host|Output).*plainApiKey/i);
  assert.doesNotMatch(saveCartesia,/apiKeyDpapi\s*=.*\$catalog/i);
  assert.match(runCartesia,/Read-DpapiSecret/);
  assert.match(runCartesia,/ZeroFreeBSTR/);
  assert.match(runCartesia,/finally\s*\{[\s\S]*Remove-Item Env:CARTESIA_API_KEY/);
  assert.match(runCartesiaFallback,/finally\s*\{[\s\S]*Remove-Item Env:CARTESIA_API_KEY/);
});
