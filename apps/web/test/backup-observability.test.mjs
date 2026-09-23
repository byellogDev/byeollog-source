import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('backup runtime logs bounded metadata and has an explicit execution limit',async()=>{
  const [api,backup,vercel]=await Promise.all([
    readFile(new URL('../api/backups.js',import.meta.url),'utf8'),
    readFile(new URL('../lib/backup.js',import.meta.url),'utf8'),
    readFile(new URL('../vercel.json',import.meta.url),'utf8').then(JSON.parse)
  ]);
  assert.doesNotMatch(api,/console\.error\([^\n]*,\s*e\s*\)/);
  assert.match(api,/\[backup\] request failed/);
  assert.match(backup,/error_code:safeBackupErrorCode\(e\)/);
  assert.doesNotMatch(backup,/error:String\(e\?\.message/);
  assert.equal(vercel.functions['api/backups.js'].maxDuration,300);
  assert.match(backup,/BACKUP_OPERATION_TIMEOUT_MS = 230\*1000/);
});
