import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

test('production preflight records an immutable source digest and dirty paths',async()=>{
  const [pkg,source]=await Promise.all([
    readFile(auditURL('../package.json',import.meta.url),'utf8'),
    readFile(auditURL('../scripts/generate-release-manifest.mjs',import.meta.url),'utf8')
  ]);
  assert.match(pkg,/"release:preflight": "npm test && npm run validate:runtime && npm run release:manifest && npm run build:public"/);
  assert.match(source,/sourceDigest/);
  assert.match(source,/workingTreeClean/);
  assert.match(source,/dirtyPaths/);
  assert.match(source,/gitCommit/);
  assert.doesNotMatch(source,/process\.env/);
});
