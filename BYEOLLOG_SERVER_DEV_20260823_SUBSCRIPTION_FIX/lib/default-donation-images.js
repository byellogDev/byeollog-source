import {normalizeSignatureImageReference,SignatureBalloonValidationError} from './signature-balloon-registry.js';

export const DEFAULT_DONATION_IMAGE_MIN_AMOUNT=0;
export const DEFAULT_DONATION_IMAGE_MAX_AMOUNT=2_147_483_647;
export const DEFAULT_DONATION_IMAGE_MAX_ITEMS=50;

function optionalAmount(value,label,fallback){
  if(value===null||value===undefined||String(value).trim()==='')return fallback;
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<DEFAULT_DONATION_IMAGE_MIN_AMOUNT||number>DEFAULT_DONATION_IMAGE_MAX_AMOUNT){
    throw new SignatureBalloonValidationError(`${label}은 0~2,147,483,647 사이의 정수로 입력해주세요.`);
  }
  return number;
}

export function normalizeDefaultDonationImageInput(input,workspaceId){
  const minAmount=optionalAmount(input?.minAmount,'최소 후원 개수',0);
  const maxAmount=optionalAmount(input?.maxAmount,'최대 후원 개수',null);
  if(maxAmount!==null&&maxAmount<minAmount)throw new SignatureBalloonValidationError('최대 후원 개수는 최소 후원 개수보다 작을 수 없습니다.');
  return {
    minAmount,maxAmount,
    pcImage:normalizeSignatureImageReference(input?.pcImage,workspaceId,'default-pc'),
    wallpaperImage:null
  };
}

export function defaultDonationImageAssetPaths(value){
  return [...new Set([value?.pcImage?.storagePath,value?.wallpaperImage?.storagePath].filter(Boolean))];
}

export function defaultDonationImageForAmount(items,amount){
  const value=Number(amount);
  if(!Number.isSafeInteger(value)||value<1)return null;
  return (Array.isArray(items)?items:[]).find(item=>{
    const min=Number(item.minAmount??item.min_amount??0);
    const rawMax=item.maxAmount!==undefined?item.maxAmount:item.max_amount;
    return value>=min&&(rawMax===null||rawMax===undefined||value<=Number(rawMax));
  })||null;
}

export function defaultDonationImageRangesOverlap(left,right){
  const leftMin=Number(left?.minAmount??left?.min_amount??0),rightMin=Number(right?.minAmount??right?.min_amount??0);
  const leftRawMax=left?.maxAmount!==undefined?left.maxAmount:left?.max_amount;
  const rightRawMax=right?.maxAmount!==undefined?right.maxAmount:right?.max_amount;
  const leftMax=leftRawMax===null||leftRawMax===undefined?Infinity:Number(leftRawMax);
  const rightMax=rightRawMax===null||rightRawMax===undefined?Infinity:Number(rightRawMax);
  return leftMin<=rightMax&&rightMin<=leftMax;
}
