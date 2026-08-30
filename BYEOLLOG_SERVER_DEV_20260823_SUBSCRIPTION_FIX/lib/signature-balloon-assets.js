import crypto from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import sharp from 'sharp';
import {inspectRouletteImageBytes} from './roulette-custom-assets.js';
import {normalizeSignatureImageReference,SignatureBalloonValidationError} from './signature-balloon-registry.js';

export const SIGNATURE_ASSET_BUCKET='byeollog-signature-assets';
export const SIGNATURE_ASSET_MAX_BYTES=12*1024*1024;
export const SIGNATURE_ASSET_ALLOWED_MIME_TYPES=Object.freeze([
  'image/png','image/jpeg','image/webp','image/gif'
]);
const MIME_EXTENSION=Object.freeze({
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'
});
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnv(name,environment=process.env){
  const value=environment[name]||'';
  if(!value)throw new SignatureBalloonValidationError('시그풍 이미지 저장소가 아직 준비되지 않았습니다.',503,'signature_storage_unavailable');
  return value;
}

function storageClient(){
  return createClient(requiredEnv('SUPABASE_URL'),requiredEnv('SUPABASE_SECRET_KEY'),{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
  });
}

function workspaceId(value){
  const id=String(value||'').trim().toLowerCase();
  if(!UUID_PATTERN.test(id))throw new SignatureBalloonValidationError('워크스페이스를 확인할 수 없습니다.',403,'signature_workspace_invalid');
  return id;
}

function validateUploadRequest(input={}){
  const kind=input.kind==='pc'?'pc':input.kind==='mobile'?'mobile':null;
  const mimeType=String(input.mimeType||'').trim().toLowerCase();
  const byteSize=Number(input.byteSize);
  if(!kind)throw new SignatureBalloonValidationError('이미지 용도를 확인할 수 없습니다.');
  if(!SIGNATURE_ASSET_ALLOWED_MIME_TYPES.includes(mimeType))throw new SignatureBalloonValidationError('PNG, JPG, WebP, GIF 이미지만 업로드할 수 있습니다.');
  if(!Number.isSafeInteger(byteSize)||byteSize<1||byteSize>SIGNATURE_ASSET_MAX_BYTES)throw new SignatureBalloonValidationError('이미지는 12MB 이하 파일만 업로드할 수 있습니다.');
  return {kind,mimeType,byteSize,extension:MIME_EXTENSION[mimeType]};
}

async function ensureBucket(client){
  const {data,error}=await client.storage.listBuckets();
  if(error)throw new SignatureBalloonValidationError('시그풍 이미지 저장소를 확인하지 못했습니다.',503,'signature_storage_failed');
  if((data||[]).some(item=>item.id===SIGNATURE_ASSET_BUCKET||item.name===SIGNATURE_ASSET_BUCKET))return;
  const {error:createError}=await client.storage.createBucket(SIGNATURE_ASSET_BUCKET,{
    public:false,fileSizeLimit:SIGNATURE_ASSET_MAX_BYTES,allowedMimeTypes:[...SIGNATURE_ASSET_ALLOWED_MIME_TYPES]
  });
  if(createError&&!String(createError.message||'').toLowerCase().includes('already')){
    throw new SignatureBalloonValidationError('시그풍 이미지 저장소를 준비하지 못했습니다.',503,'signature_storage_failed');
  }
}

function assertScopedPath(path,value,expectedKind=null){
  const id=workspaceId(value),text=String(path||'').trim();
  const prefix=expectedKind?`workspaces/${id}/${expectedKind}/`:`workspaces/${id}/`;
  if(!text.startsWith(prefix))throw new SignatureBalloonValidationError('다른 워크스페이스 또는 용도의 이미지는 사용할 수 없습니다.',403,'signature_asset_scope_mismatch');
  return text;
}

async function signedPreviewUrl(client,path){
  const {data,error}=await client.storage.from(SIGNATURE_ASSET_BUCKET).createSignedUrl(path,15*60);
  if(error||!data?.signedUrl)throw new SignatureBalloonValidationError('시그풍 이미지 미리보기를 만들지 못했습니다.',503,'signature_preview_failed');
  return data.signedUrl;
}

export function signatureAssetOrigin(environment=process.env){
  return new URL(requiredEnv('SUPABASE_URL',environment)).origin;
}

export async function createSignatureAssetUploadTicket(value,input={}){
  const id=workspaceId(value),upload=validateUploadRequest(input),client=storageClient();
  await ensureBucket(client);
  const path=`workspaces/${id}/${upload.kind}/${crypto.randomUUID()}.${upload.extension}`;
  const {data,error}=await client.storage.from(SIGNATURE_ASSET_BUCKET).createSignedUploadUrl(path,{upsert:false});
  if(error||!data?.signedUrl)throw new SignatureBalloonValidationError('시그풍 이미지 업로드 주소를 만들지 못했습니다.',503,'signature_upload_ticket_failed');
  return {path,signedUrl:data.signedUrl,mimeType:upload.mimeType,maxBytes:SIGNATURE_ASSET_MAX_BYTES};
}

export async function verifySignatureAssetUpload(value,path,kind){
  const id=workspaceId(value),safePath=assertScopedPath(path,id,kind),client=storageClient();
  const {data,error}=await client.storage.from(SIGNATURE_ASSET_BUCKET).download(safePath);
  if(error||!data)throw new SignatureBalloonValidationError('업로드한 시그풍 이미지를 확인하지 못했습니다.',400,'signature_asset_missing');
  const inspected=inspectRouletteImageBytes(Buffer.from(await data.arrayBuffer()));
  const extension=MIME_EXTENSION[inspected.mimeType];
  if(!safePath.endsWith(`.${extension}`))throw new SignatureBalloonValidationError('업로드한 이미지 형식이 파일 정보와 다릅니다.');
  const reference=normalizeSignatureImageReference({storagePath:safePath,...inspected},id,kind);
  return {...reference,previewUrl:await signedPreviewUrl(client,safePath)};
}

export async function buildSignatureWallpaperBuffer(input){
  return sharp(input,{animated:false,limitInputPixels:4096*4096})
    .rotate()
    .resize(320,240,{fit:'contain',position:'south',background:{r:0,g:0,b:0,alpha:0}})
    .webp({lossless:true,effort:4})
    .toBuffer();
}

export async function deriveSignatureWallpaperAsset(value,sourceReference){
  const id=workspaceId(value);
  const source=normalizeSignatureImageReference(sourceReference,id,'pc');
  const client=storageClient();
  await ensureBucket(client);
  const {data,error}=await client.storage.from(SIGNATURE_ASSET_BUCKET).download(source.storagePath);
  if(error||!data)throw new SignatureBalloonValidationError('풍벽지용 이미지를 만들 원본을 불러오지 못했습니다.',400,'signature_wallpaper_source_missing');
  let output;
  try{
    output=await buildSignatureWallpaperBuffer(Buffer.from(await data.arrayBuffer()));
  }catch{
    throw new SignatureBalloonValidationError('풍벽지용 이미지 자동 변환에 실패했습니다.',400,'signature_wallpaper_transform_failed');
  }
  const inspected=inspectRouletteImageBytes(output);
  const path=`workspaces/${id}/wallpaper/${crypto.randomUUID()}.webp`;
  const {error:uploadError}=await client.storage.from(SIGNATURE_ASSET_BUCKET).upload(path,output,{
    contentType:'image/webp',cacheControl:'31536000',upsert:false
  });
  if(uploadError)throw new SignatureBalloonValidationError('풍벽지용 이미지를 저장하지 못했습니다.',503,'signature_wallpaper_storage_failed');
  const reference=normalizeSignatureImageReference({storagePath:path,...inspected},id,'wallpaper');
  return {...reference,previewUrl:await signedPreviewUrl(client,path)};
}

export async function hydrateSignatureAssetPreview(value,reference,kind){
  const id=workspaceId(value),safe=normalizeSignatureImageReference(reference,id,kind),client=storageClient();
  return {...safe,previewUrl:await signedPreviewUrl(client,safe.storagePath)};
}

export async function hydrateSignatureAssetPreviews(value,references=[]){
  const id=workspaceId(value);
  const safe=(Array.isArray(references)?references:[]).map(item=>({
    kind:item?.kind,reference:normalizeSignatureImageReference(item?.reference,id,item?.kind)
  }));
  if(!safe.length)return [];
  const client=storageClient(),paths=safe.map(item=>item.reference.storagePath);
  const {data,error}=await client.storage.from(SIGNATURE_ASSET_BUCKET).createSignedUrls(paths,15*60);
  if(error||!Array.isArray(data)||data.length!==paths.length){
    throw new SignatureBalloonValidationError('시그풍 이미지 미리보기를 만들지 못했습니다.',503,'signature_preview_failed');
  }
  return safe.map((item,index)=>{
    const signedUrl=data[index]?.signedUrl;
    if(!signedUrl)throw new SignatureBalloonValidationError('시그풍 이미지 미리보기를 만들지 못했습니다.',503,'signature_preview_failed');
    return {...item.reference,previewUrl:signedUrl};
  });
}

export async function removeSignatureAssets(paths){
  const unique=[...new Set((paths||[]).filter(Boolean))];
  if(!unique.length)return;
  const {error}=await storageClient().storage.from(SIGNATURE_ASSET_BUCKET).remove(unique);
  if(error)throw error;
}
