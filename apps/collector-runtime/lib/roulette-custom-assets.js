import crypto from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {normalizeRouletteCustomImageReference} from './native-roulette.js';
import {isScopedAssetPath} from './scoped-asset-path.js';

export const ROULETTE_ASSET_BUCKET='byeollog-roulette-assets';
export const ROULETTE_ASSET_MAX_BYTES=12*1024*1024;
export const ROULETTE_ASSET_ALLOWED_MIME_TYPES=Object.freeze([
  'image/png','image/jpeg','image/webp','image/gif'
]);

const MIME_EXTENSION=Object.freeze({
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'
});

export class RouletteAssetError extends Error{
  constructor(message,status=400,code='invalid_roulette_asset'){
    super(message);
    this.name='RouletteAssetError';
    this.status=status;
    this.code=code;
  }
}

function env(name,environment=process.env){
  const value=environment[name]||'';
  if(!value)throw new RouletteAssetError('이미지 저장소가 아직 준비되지 않았습니다.',503,'roulette_asset_storage_unavailable');
  return value;
}

function storageClient(){
  return createClient(env('SUPABASE_URL'),env('SUPABASE_SECRET_KEY'),{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
  });
}

function workspaceId(value){
  const text=String(value||'').trim().toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)){
    throw new RouletteAssetError('워크스페이스를 확인할 수 없습니다.',403,'roulette_asset_workspace_invalid');
  }
  return text;
}

function byteSize(value){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1||number>ROULETTE_ASSET_MAX_BYTES){
    throw new RouletteAssetError('이미지는 12MB 이하 파일만 업로드할 수 있습니다.');
  }
  return number;
}

function mimeType(value){
  const text=String(value||'').trim().toLowerCase();
  if(!ROULETTE_ASSET_ALLOWED_MIME_TYPES.includes(text)){
    throw new RouletteAssetError('PNG, JPG, WebP, GIF 이미지만 업로드할 수 있습니다.');
  }
  return text;
}

export function validateRouletteUploadRequest(input={}){
  const kind=input.kind==='series'?'series':input.kind==='single'?'single':null;
  if(!kind)throw new RouletteAssetError('이미지 용도를 확인할 수 없습니다.');
  const type=mimeType(input.mimeType);
  const size=byteSize(input.byteSize);
  return {kind,mimeType:type,byteSize:size,extension:MIME_EXTENSION[type]};
}

async function ensureBucket(client){
  const {data,error}=await client.storage.listBuckets();
  if(error)throw new RouletteAssetError('이미지 저장소를 확인하지 못했습니다.',503,'roulette_asset_storage_failed');
  if((data||[]).some(item=>item.id===ROULETTE_ASSET_BUCKET||item.name===ROULETTE_ASSET_BUCKET))return;
  const {error:createError}=await client.storage.createBucket(ROULETTE_ASSET_BUCKET,{
    public:true,
    fileSizeLimit:ROULETTE_ASSET_MAX_BYTES,
    allowedMimeTypes:[...ROULETTE_ASSET_ALLOWED_MIME_TYPES]
  });
  if(createError&&!String(createError.message||'').toLowerCase().includes('already')){
    throw new RouletteAssetError('이미지 저장소를 준비하지 못했습니다.',503,'roulette_asset_storage_failed');
  }
}

export function rouletteAssetPublicUrl(path,environment=process.env){
  const root=env('SUPABASE_URL',environment).replace(/\/+$/,'');
  const encoded=String(path||'').split('/').map(encodeURIComponent).join('/');
  return `${root}/storage/v1/object/public/${ROULETTE_ASSET_BUCKET}/${encoded}`;
}

export function rouletteAssetOrigin(){
  return new URL(env('SUPABASE_URL')).origin;
}

export function assertRouletteAssetWorkspace(path,value){
  const id=workspaceId(value);
  const text=String(path||'').trim();
  if(!isScopedAssetPath(text,id)){
    throw new RouletteAssetError('다른 워크스페이스의 이미지는 사용할 수 없습니다.',403,'roulette_asset_workspace_mismatch');
  }
  return text;
}

export async function createRouletteAssetUploadTicket(value,input={}){
  const id=workspaceId(value);
  const upload=validateRouletteUploadRequest(input);
  const client=storageClient();
  await ensureBucket(client);
  const path=`workspaces/${id}/${upload.kind}/${crypto.randomUUID()}.${upload.extension}`;
  const {data,error}=await client.storage.from(ROULETTE_ASSET_BUCKET).createSignedUploadUrl(path,{upsert:false});
  if(error||!data?.signedUrl){
    throw new RouletteAssetError('이미지 업로드 주소를 만들지 못했습니다.',503,'roulette_asset_ticket_failed');
  }
  return {path,signedUrl:data.signedUrl,mimeType:upload.mimeType,maxBytes:ROULETTE_ASSET_MAX_BYTES};
}

function uint24le(bytes,offset){
  return bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16);
}

function jpegDimensions(bytes){
  let offset=2;
  while(offset+9<bytes.length){
    if(bytes[offset]!==0xff){offset+=1;continue}
    const marker=bytes[offset+1];
    if(marker===0xd8||marker===0xd9){offset+=2;continue}
    const length=(bytes[offset+2]<<8)|bytes[offset+3];
    if(length<2||offset+2+length>bytes.length)break;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      return {width:(bytes[offset+7]<<8)|bytes[offset+8],height:(bytes[offset+5]<<8)|bytes[offset+6]};
    }
    offset+=2+length;
  }
  throw new RouletteAssetError('JPG 이미지 크기를 확인할 수 없습니다.');
}

export function inspectRouletteImageBytes(value){
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value||[]);
  byteSize(bytes.length);
  let mime;
  let width;
  let height;
  if(bytes.length>=45
    &&bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
    &&bytes.subarray(12,16).toString('ascii')==='IHDR'
    &&bytes.subarray(-8).equals(Buffer.from([0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]))){
    mime='image/png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else if(bytes.length>=14&&bytes.at(-1)===0x3b&&(bytes.subarray(0,6).toString('ascii')==='GIF87a'||bytes.subarray(0,6).toString('ascii')==='GIF89a')){
    mime='image/gif';width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);
  }else if(bytes.length>=12&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9){
    mime='image/jpeg';({width,height}=jpegDimensions(bytes));
  }else if(bytes.length>=30&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){
    mime='image/webp';
    const kind=bytes.subarray(12,16).toString('ascii');
    if(kind==='VP8X'){
      width=uint24le(bytes,24)+1;height=uint24le(bytes,27)+1;
    }else if(kind==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a){
      width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;
    }else if(kind==='VP8L'&&bytes[20]===0x2f){
      width=1+((bytes[21]|(bytes[22]<<8))&0x3fff);
      height=1+(((bytes[22]>>6)|(bytes[23]<<2)|(bytes[24]<<10))&0x3fff);
    }
  }
  if(!mime||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1){
    throw new RouletteAssetError('이미지 파일 내용을 확인할 수 없습니다.');
  }
  if(width>4096||height>4096){
    throw new RouletteAssetError('이미지 가로·세로 크기는 각각 4096px 이하여야 합니다.');
  }
  return {mimeType:mime,byteSize:bytes.length,width,height,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}

export async function verifyRouletteAssetUpload(value,path){
  const safePath=assertRouletteAssetWorkspace(path,value);
  const client=storageClient();
  const {data,error}=await client.storage.from(ROULETTE_ASSET_BUCKET).download(safePath);
  if(error||!data)throw new RouletteAssetError('업로드한 이미지를 확인하지 못했습니다.',400,'roulette_asset_missing');
  const inspected=inspectRouletteImageBytes(Buffer.from(await data.arrayBuffer()));
  const extension=MIME_EXTENSION[inspected.mimeType];
  if(!safePath.endsWith(`.${extension}`))throw new RouletteAssetError('업로드한 이미지 형식이 파일 정보와 다릅니다.');
  const normalized=normalizeRouletteCustomImageReference({storagePath:safePath,...inspected});
  return {...normalized,previewUrl:rouletteAssetPublicUrl(safePath)};
}

export function rouletteAssetPaths(draft){
  return [draft?.customSingleImage?.storagePath,draft?.customSeriesImage?.storagePath]
    .filter((item,index,array)=>item&&array.indexOf(item)===index);
}

export async function removeRouletteAssets(paths){
  const unique=[...new Set((paths||[]).filter(Boolean))];
  if(!unique.length)return;
  const client=storageClient();
  const {error}=await client.storage.from(ROULETTE_ASSET_BUCKET).remove(unique);
  if(error)throw error;
}
