import {normalizeSignatureImageReference,SignatureBalloonValidationError} from './signature-balloon-registry.js';

export const DEFAULT_DONATION_IMAGE_MIN_AMOUNT=1;
export const DEFAULT_DONATION_IMAGE_MAX_AMOUNT=1_000_000;
export const DEFAULT_DONATION_IMAGE_MAX_ITEMS=50;

function exactAmount(value,label){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<DEFAULT_DONATION_IMAGE_MIN_AMOUNT||number>DEFAULT_DONATION_IMAGE_MAX_AMOUNT){
    throw new SignatureBalloonValidationError(`${label}은 1~1,000,000 사이의 정수로 입력해주세요.`);
  }
  return number;
}

export function normalizeDefaultDonationImageInput(input,workspaceId){
  const minAmount=exactAmount(input?.minAmount,'최소 후원 개수');
  const maxAmount=exactAmount(input?.maxAmount,'최대 후원 개수');
  if(maxAmount<minAmount)throw new SignatureBalloonValidationError('최대 후원 개수는 최소 후원 개수보다 작을 수 없습니다.');
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
  return (Array.isArray(items)?items:[]).find(item=>value>=Number(item.minAmount??item.min_amount)&&value<=Number(item.maxAmount??item.max_amount))||null;
}
