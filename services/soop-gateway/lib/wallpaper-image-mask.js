import sharp from 'sharp';
import {normalizeSoopCeremonyImageUrl} from './native-roulette.js';

const MAX_IMAGE_BYTES=12*1024*1024;
const MASK_SIZE=96;

function supabaseOrigin(environment){
  try{return new URL(String(environment?.SUPABASE_URL||'')).origin}catch{return null}
}

export function normalizeWallpaperMaskImageUrl(value,environment=process.env){
  const raw=String(value||'').trim();
  if(!raw||raw.length>4096)return null;
  const soop=normalizeSoopCeremonyImageUrl(raw);
  if(soop)return soop;
  try{
    const url=new URL(raw),allowedOrigin=supabaseOrigin(environment);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!allowedOrigin||url.origin!==allowedOrigin)return null;
    url.hash='';
    return url.href;
  }catch{return null}
}

async function fetchAllowedImage(initialUrl,{environment,fetchImpl}){
  let current=initialUrl;
  for(let redirectCount=0;redirectCount<=3;redirectCount++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
    let response;
    try{
      response=await fetchImpl(current,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'}});
    }finally{clearTimeout(timer)}
    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');
      if(!location||redirectCount===3)throw Object.assign(new Error('이미지 이동 경로를 확인하지 못했습니다.'),{status:502});
      current=normalizeWallpaperMaskImageUrl(new URL(location,current).href,environment);
      if(!current)throw Object.assign(new Error('허용되지 않은 이미지 이동 경로입니다.'),{status:400});
      continue;
    }
    if(!response.ok)throw Object.assign(new Error('이미지를 불러오지 못했습니다.'),{status:502});
    const type=String(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
    if(!type.startsWith('image/'))throw Object.assign(new Error('이미지 형식이 아닙니다.'),{status:415});
    const declared=Number(response.headers.get('content-length')||0);
    if(Number.isFinite(declared)&&declared>MAX_IMAGE_BYTES)throw Object.assign(new Error('이미지가 너무 큽니다.'),{status:413});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw Object.assign(new Error('이미지 크기를 처리할 수 없습니다.'),{status:413});
    return {bytes,publicSoop:Boolean(normalizeSoopCeremonyImageUrl(current))};
  }
  throw Object.assign(new Error('이미지를 불러오지 못했습니다.'),{status:502});
}

export async function createWallpaperImageMask(value,{environment=process.env,fetchImpl=globalThis.fetch,sharpImpl=sharp}={}){
  const url=normalizeWallpaperMaskImageUrl(value,environment);
  if(!url)throw Object.assign(new Error('허용되지 않은 풍벽지 이미지 주소입니다.'),{status:400});
  const {bytes,publicSoop}=await fetchAllowedImage(url,{environment,fetchImpl});
  try{
    const source=sharpImpl(bytes,{animated:false,limitInputPixels:40_000_000,failOn:'error'}),metadata=await source.metadata();
    if(!metadata.width||!metadata.height)throw new Error('missing dimensions');
    const alpha=await source.clone().ensureAlpha().extractChannel('alpha').resize(MASK_SIZE,MASK_SIZE,{fit:'fill'}).raw().toBuffer();
    let total=0;
    for(const value of alpha)total+=value;
    return {width:metadata.width,height:metadata.height,maskWidth:MASK_SIZE,maskHeight:MASK_SIZE,alpha:alpha.toString('base64'),density:total/(alpha.length*255),publicSoop};
  }catch{
    throw Object.assign(new Error('이미지 투명 영역을 분석하지 못했습니다.'),{status:422});
  }
}
