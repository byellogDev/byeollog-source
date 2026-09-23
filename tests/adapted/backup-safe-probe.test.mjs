import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('daily backup verifier uses injected credentials without persisting or printing them',async()=>{
  const source=await readFile(auditURL('../tools/Invoke-DailyBackupSafe.mjs',import.meta.url),'utf8');
  assert.match(source,/process\.env\.CRON_SECRET/);
  assert.match(source,/https:\/\/byeollog\.com/);
  assert.match(source,/redirect:'error'/);
  assert.doesNotMatch(source,/console\.(?:log|info|error)\([^)]*secret/i);
  assert.doesNotMatch(source,/writeFile|appendFile|['"`]\.env/);
});
