import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('recovered production Edge sources match the read-only capture manifest',async()=>{
  const manifest=JSON.parse(await readFile(
    new URL('supabase/LIVE_EDGE_SOURCE_MANIFEST.json',root),'utf8'));
  assert.equal(manifest.schemaVersion,1);
  assert.equal(manifest.projectRef,'offslvwaugvjotkywlus');
  assert.deepEqual(manifest.functions.map(item=>({
    slug:item.slug,
    version:item.version,
    verifyJwt:item.verifyJwt,
    status:item.status
  })),[
    {slug:'agent-runtime-g3a',version:4,verifyJwt:true,status:'ACTIVE'},
    {slug:'event-runtime-g3a',version:2,verifyJwt:true,status:'ACTIVE'},
    {slug:'execution-worker-g3a',version:1,verifyJwt:true,status:'ACTIVE'}
  ]);

  const manifestPaths=new Set(manifest.files.map(item=>item.path));
  for(const fn of manifest.functions){
    assert.equal(fn.verifyJwt,true);
    assert.match(fn.bundleSha256,/^[a-f0-9]{64}$/);
    for(const path of fn.files)assert.ok(manifestPaths.has(path),`${fn.slug}: ${path}`);
  }

  const auditedCapabilityDeltas=new Set();
  const auditedSourceDeltas=new Map([
    ['_shared/agent-device-status.ts',{
      bytes:3233,
      sha256:'d5c12239670af1d563af069e336570b87c83dcc1fd530df7f636be603b771722'
    }],
    ['agent-runtime/index.ts',{
      bytes:29375,
      sha256:'6e3a8e132b703a087037cf824fa7c49d9fb139215ca764f2a78213c9da49529b'
    }],
    ['event-runtime/index.ts',{
      bytes:12941,
      sha256:'175cb08d4a8a4a85f4f143889522776875b3fcf7ccb17f0dd6e004703db6133e'
    }]
  ]);
  for(const file of manifest.files){
    let bytes=await readFile(new URL(`supabase/functions/${file.path}`,root));
    const sourceDelta=auditedSourceDeltas.get(file.path);
    if(sourceDelta){
      assert.equal(bytes.length,sourceDelta.bytes,file.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),sourceDelta.sha256,file.path);
      continue;
    }
    if(auditedCapabilityDeltas.has(file.path)){
      const source=bytes.toString('utf8');
      assert.equal((source.match(/  "raffle\.overlay",\n/g)??[]).length,1,file.path);
      bytes=Buffer.from(source.replace('  "raffle.overlay",\n',''),'utf8');
    }
    assert.equal(bytes.length,file.bytes,file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
  }
});
