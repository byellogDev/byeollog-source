import {isScopedAssetPath} from './scoped-asset-path.js';
const MIME_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SIGNATURE_BALLOON_MIN_COUNT=1;
export const SIGNATURE_BALLOON_MAX_COUNT=30000;
export const SIGNATURE_BALLOON_MAX_ITEMS=200;

export class SignatureBalloonValidationError extends Error{
  constructor(message,status=400,code='invalid_signature_balloon'){
    super(message);
    this.name='SignatureBalloonValidationError';
    this.status=status;
    this.code=code;
  }
}

function exactInteger(value,min,max,label){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max){
    throw new SignatureBalloonValidationError(`${label}은 ${min.toLocaleString()}~${max.toLocaleString()} 사이의 정수로 입력해주세요.`);
  }
  return number;
}

function safeWorkspaceId(value){
  const id=String(value||'').trim().toLowerCase();
  if(!UUID_PATTERN.test(id))throw new SignatureBalloonValidationError('워크스페이스를 확인할 수 없습니다.',403,'signature_workspace_invalid');
  return id;
}

export function normalizeSignatureImageReference(value,workspaceId,kind){
  const id=safeWorkspaceId(workspaceId);
  if(!value||typeof value!=='object'||Array.isArray(value)){
    const label=kind==='pc'?'PC':kind==='mobile'?'모바일':'풍벽지';
    throw new SignatureBalloonValidationError(`${label} 이미지를 등록해주세요.`);
  }
  const storagePath=String(value.storagePath||'').trim();
  const mimeType=String(value.mimeType||'').trim().toLowerCase();
  const byteSize=exactInteger(value.byteSize,1,12*1024*1024,'이미지 용량');
  const width=exactInteger(value.width,1,4096,'이미지 가로 크기');
  const height=exactInteger(value.height,1,4096,'이미지 세로 크기');
  const sha256=String(value.sha256||'').trim().toLowerCase();
  if(!isScopedAssetPath(storagePath,id,kind)){
    throw new SignatureBalloonValidationError('다른 워크스페이스 또는 용도의 이미지는 사용할 수 없습니다.',403,'signature_asset_scope_mismatch');
  }
  if(!MIME_TYPES.has(mimeType)||!/^[0-9a-f]{64}$/.test(sha256)){
    throw new SignatureBalloonValidationError('이미지 확인 정보가 올바르지 않습니다.');
  }
  return {storagePath,mimeType,byteSize,width,height,sha256};
}

export function normalizeSignatureBalloonInput(input,workspaceId){
  const balloonCount=exactInteger(input?.balloonCount,SIGNATURE_BALLOON_MIN_COUNT,SIGNATURE_BALLOON_MAX_COUNT,'별풍선 개수');
  const rawName=String(input?.displayName||'').trim();
  const displayName=rawName||`별풍선 ${balloonCount.toLocaleString()}개`;
  if(displayName.length>80||/[\u0000-\u001f\u007f]/.test(displayName)){
    throw new SignatureBalloonValidationError('시그풍 이름은 제어문자 없이 80자 이하로 입력해주세요.');
  }
  return {
    balloonCount,
    displayName,
    pcImage:normalizeSignatureImageReference(input?.pcImage,workspaceId,'pc'),
    mobileImage:null,
    wallpaperImage:null
  };
}

export function signatureBalloonAssetPaths(value){
  return [...new Set([value?.pcImage?.storagePath,value?.mobileImage?.storagePath,value?.wallpaperImage?.storagePath].filter(Boolean))];
}
