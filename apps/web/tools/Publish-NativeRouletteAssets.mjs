import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import crypto from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {NATIVE_ROULETTE_ASSETS,NATIVE_ROULETTE_ASSET_BUCKET} from '../lib/native-roulette-assets.js';

function required(name){
  const value=String(process.env[name]||'').trim();
  if(!value)throw new Error(`Missing ${name}`);
  return value;
}

const client=createClient(required('SUPABASE_URL'),required('SUPABASE_SECRET_KEY'),{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
});
const {data:buckets,error:listError}=await client.storage.listBuckets();
if(listError)throw listError;
if(!(buckets||[]).some(bucket=>bucket.id===NATIVE_ROULETTE_ASSET_BUCKET)){
  const {error}=await client.storage.createBucket(NATIVE_ROULETTE_ASSET_BUCKET,{
    public:true,fileSizeLimit:30*1024*1024,allowedMimeTypes:['image/webp']
  });
  if(error)throw error;
}

const published=[];
for(const asset of NATIVE_ROULETTE_ASSETS){
  const source=resolve(process.cwd(),'..',asset.sourceRelativePath);
  const bytes=await readFile(source);
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==asset.byteSize||digest!==asset.contentSha256){
    throw new Error(`Immutable asset mismatch: ${asset.fileName}`);
  }
  const legacyPath=`catalog/v1/${asset.fileName}`;
  const {error:moveError}=await client.storage.from(NATIVE_ROULETTE_ASSET_BUCKET).move(legacyPath,asset.publishedPath);
  if(moveError){
    const {error}=await client.storage.from(NATIVE_ROULETTE_ASSET_BUCKET).upload(asset.publishedPath,bytes,{
      contentType:'image/webp',cacheControl:'31536000',upsert:true
    });
    if(error)throw error;
    await client.storage.from(NATIVE_ROULETTE_ASSET_BUCKET).remove([legacyPath]);
  }
  // A server-side move preserves the legacy object's cache metadata. Rewrite
  // the immutable object once so every release is served with a one-year CDN
  // cache and never downloads the 20+ MB animation for every spin.
  const {error:updateError}=await client.storage.from(NATIVE_ROULETTE_ASSET_BUCKET).update(asset.publishedPath,bytes,{
    contentType:'image/webp',cacheControl:'31536000',upsert:true
  });
  if(updateError)throw updateError;
  published.push({assetKey:asset.key,path:asset.publishedPath,sha256:digest,byteSize:bytes.length});
  process.stdout.write(`published ${asset.fileName} (${bytes.length} bytes)\n`);
}
process.stdout.write(`${JSON.stringify({bucket:NATIVE_ROULETTE_ASSET_BUCKET,published},null,2)}\n`);
