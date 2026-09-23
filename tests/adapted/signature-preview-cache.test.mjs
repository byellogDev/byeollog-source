import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSignaturePreviewCacheForTests,
  hydrateSignatureAssetPreview,
  hydrateSignatureAssetPreviews
} from '../../apps/admin-runtime/lib/signature-balloon-assets.js';

const workspaceId='10000000-0000-4000-8000-000000000001';
const reference=(name='asset')=>({
  storagePath:`workspaces/${workspaceId}/wallpaper/${name}.webp`,
  mimeType:'image/webp',byteSize:1234,width:320,height:240,sha256:'a'.repeat(64)
});

function fakeClient(){
  const calls={single:0,batch:0,paths:[]};
  return {calls,storage:{from:()=>({
    async createSignedUrl(path,expiresIn){
      calls.single++;calls.paths.push(path);
      return {data:{signedUrl:`https://storage.test/${path}?single=${calls.single}&ttl=${expiresIn}`},error:null};
    },
    async createSignedUrls(paths,expiresIn){
      calls.batch++;calls.paths.push(...paths);
      return {data:paths.map(path=>({signedUrl:`https://storage.test/${path}?batch=${calls.batch}&ttl=${expiresIn}`})),error:null};
    }
  })}};
}

test.beforeEach(()=>clearSignaturePreviewCacheForTests());

test('signed preview URL is reused while it has a five-minute safety margin',async()=>{
  const client=fakeClient(),image=reference();
  const first=await hydrateSignatureAssetPreview(workspaceId,image,'wallpaper',{client,now:1_000});
  const reused=await hydrateSignatureAssetPreview(workspaceId,image,'wallpaper',{client,now:1_000+10*60*1000-1});
  assert.equal(reused.previewUrl,first.previewUrl);
  assert.equal(client.calls.single,1);
  const refreshed=await hydrateSignatureAssetPreview(workspaceId,image,'wallpaper',{client,now:1_000+10*60*1000});
  assert.notEqual(refreshed.previewUrl,first.previewUrl);
  assert.equal(client.calls.single,2);
});

test('batch hydration signs only cache misses and deduplicates repeated paths',async()=>{
  const client=fakeClient(),one=reference('one'),two=reference('two');
  await hydrateSignatureAssetPreview(workspaceId,one,'wallpaper',{client,now:5_000});
  const result=await hydrateSignatureAssetPreviews(workspaceId,[
    {kind:'wallpaper',reference:one},{kind:'wallpaper',reference:two},{kind:'wallpaper',reference:two}
  ],{client,now:6_000});
  assert.equal(client.calls.single,1);
  assert.equal(client.calls.batch,1);
  assert.deepEqual(client.calls.paths,[one.storagePath,two.storagePath]);
  assert.equal(result[1].previewUrl,result[2].previewUrl);
});

test('an empty or fully cached read does not construct a storage client',async()=>{
  const client=fakeClient(),one=reference('cached');
  const first=await hydrateSignatureAssetPreview(workspaceId,one,'wallpaper',{client,now:5_000});
  const reused=await hydrateSignatureAssetPreview(workspaceId,one,'wallpaper',{now:6_000});
  const batch=await hydrateSignatureAssetPreviews(workspaceId,[{kind:'wallpaper',reference:one}],{now:6_000});
  const empty=await hydrateSignatureAssetPreviews(workspaceId,[],{now:6_000});
  assert.equal(reused.previewUrl,first.previewUrl);
  assert.equal(batch[0].previewUrl,first.previewUrl);
  assert.deepEqual(empty,[]);
  assert.equal(client.calls.single,1);
});

test('workspace and kind checks run before a cached URL can be returned',async()=>{
  const client=fakeClient(),image=reference();
  await hydrateSignatureAssetPreview(workspaceId,image,'wallpaper',{client,now:1_000});
  await assert.rejects(
    hydrateSignatureAssetPreview('20000000-0000-4000-8000-000000000002',image,'wallpaper',{client,now:2_000}),
    error=>error?.status===403&&error?.code==='signature_asset_scope_mismatch'
  );
  await assert.rejects(
    hydrateSignatureAssetPreview(workspaceId,image,'pc',{client,now:2_000}),
    error=>error?.status===403&&error?.code==='signature_asset_scope_mismatch'
  );
  assert.equal(client.calls.single,1);
});
