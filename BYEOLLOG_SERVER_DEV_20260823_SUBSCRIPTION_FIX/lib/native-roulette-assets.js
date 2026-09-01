// Canonical source inventory for the seven final, clean-edge WebP animations.
// The large immutable files remain in the reviewed artwork output directory
// until the dedicated roulette asset release is published. Runtime code must
// use the digest and byte size below, never a mutable filename alone.
export const NATIVE_ROULETTE_ASSETS=Object.freeze([
  Object.freeze({
    key:'roulette_navy_gold_v1',
    displayName:'네이비 · 골드',
    fileName:'roulette-01-navy-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-01-navy-gold.webp',
    previewByteSize:82_814,
    previewSha256:'e87242e094b670f982de13617310947c18ba7fe3162374d17969ff44b7549e64',
    contentSha256:'8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',
    byteSize:25_698_598,
    swatch:['#0b1f44','#dca92f']
  }),
  Object.freeze({
    key:'roulette_royal_purple_rose_gold_v1',
    displayName:'로열 퍼플 · 로즈 골드',
    fileName:'roulette-02-royal-purple-rose-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-02-royal-purple-rose-gold.webp',
    previewByteSize:79_126,
    previewSha256:'8775a39459e0ab9f3a3811af1776b2854e09a6856c761b4d2c265316313f2ac7',
    contentSha256:'7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b',
    byteSize:22_339_256,
    swatch:['#4a237a','#d99587']
  }),
  Object.freeze({
    key:'roulette_emerald_champagne_v1',
    displayName:'에메랄드 · 샴페인',
    fileName:'roulette-03-emerald-champagne-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-03-emerald-champagne.webp',
    previewByteSize:83_268,
    previewSha256:'43cca869616d8d7fa10c9ff54ca9cc14b566273ec28414202049168efe9eddff',
    contentSha256:'69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed',
    byteSize:22_276_620,
    swatch:['#08705f','#e6c989']
  }),
  Object.freeze({
    key:'roulette_burgundy_pale_gold_v1',
    displayName:'버건디 · 페일 골드',
    fileName:'roulette-04-burgundy-pale-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-04-burgundy-pale-gold.webp',
    previewByteSize:78_894,
    previewSha256:'fd74e89287a9726e6945fcb801de7718b864f0f1a39dfd3f6ed07688d25e7503',
    contentSha256:'ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f',
    byteSize:21_504_782,
    swatch:['#721f35','#ddc47c']
  }),
  Object.freeze({
    key:'roulette_graphite_cyan_v1',
    displayName:'그래파이트 · 시안',
    fileName:'roulette-05-graphite-cyan-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-05-graphite-cyan.webp',
    previewByteSize:78_012,
    previewSha256:'025d1100c743ae2f6575be440da1beeef8efa3ce2446f7db39f63d1be7ffd75a',
    contentSha256:'68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77',
    byteSize:21_478_638,
    swatch:['#242a33','#1dc7d6']
  }),
  Object.freeze({
    key:'roulette_pastel_powder_blue_peach_v1',
    displayName:'파우더 블루 · 피치',
    fileName:'roulette-06-pastel-powder-blue-peach-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-06-powder-blue-peach.webp',
    previewByteSize:75_906,
    previewSha256:'0f5eb648548458f6bcae76b5a93a4802ee176caa91f5ff49befe2ceffd3fb4a3',
    contentSha256:'466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7',
    byteSize:22_176_726,
    swatch:['#a9cde7','#f2b391']
  }),
  Object.freeze({
    key:'roulette_pastel_lavender_butter_v1',
    displayName:'더스티 라벤더 · 버터',
    fileName:'roulette-07-pastel-dusty-lavender-butter-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-07-lavender-butter.webp',
    previewByteSize:73_914,
    previewSha256:'9056da48d01e45da86a28c468fcb83a8965d8bf16f83f0589f20bc24c0e25988',
    contentSha256:'844bbf142e2269c371a7c0bad202edf683b90e8393e6d23638558de1d85d7af5',
    byteSize:21_756_766,
    swatch:['#aa9bc5','#eadb8d']
  })
].map(asset=>Object.freeze({
  ...asset,
  mimeType:'image/webp',
  widthPx:1920,
  heightPx:1080,
  frameCount:91,
  durationMs:4800,
  presentationDurationMs:3000,
  deliveryStatus:'published',
  publishedPath:`assets/native-roulette/${asset.contentSha256}.webp`,
  sourceRelativePath:`output/roulette_overlay/color_animations_clean_edge/${asset.fileName}`
})));

export const NATIVE_ROULETTE_ASSET_BUCKET='byeollog-native-roulette-assets';

export function nativeRouletteAssetPublicUrl(asset,env=process.env){
  const root=String(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
  if(!root||!asset?.publishedPath)return asset?.previewUrl||'';
  const path=asset.publishedPath.split('/').map(encodeURIComponent).join('/');
  return `${root}/storage/v1/object/public/${NATIVE_ROULETTE_ASSET_BUCKET}/${path}`;
}

export const NATIVE_ROULETTE_ASSET_BY_KEY=Object.freeze(Object.fromEntries(
  NATIVE_ROULETTE_ASSETS.map(asset=>[asset.key,asset])
));

export function publicNativeRouletteAsset(asset){
  return {
    key:asset.key,
    displayName:asset.displayName,
    previewUrl:asset.previewUrl,
    mimeType:asset.mimeType,
    contentSha256:asset.contentSha256,
    byteSize:asset.byteSize,
    widthPx:asset.widthPx,
    heightPx:asset.heightPx,
    frameCount:asset.frameCount,
    durationMs:asset.durationMs,
    presentationDurationMs:asset.presentationDurationMs,
    deliveryStatus:asset.deliveryStatus,
    swatch:[...asset.swatch]
  };
}
