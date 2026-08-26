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
      bytes:3532,
      sha256:'0e1c4ce4394383a2d9b7035997ef77666ba07a537886e71bd95789ec7f5f64cc'
    }],
    ['agent-runtime/index.ts',{
      bytes:29559,
      sha256:'d50456e459f98d214e252a595a2971b15adf9149652de12b3496fafeed329817'
    }],
    ['event-runtime/index.ts',{
      bytes:13111,
      sha256:'b6f322542acfbaa6dcbebff209fe78cfc10a5c478d7e82fc856c02c52f7c89d4'
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
