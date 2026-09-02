// Canonical source inventory for the seven final, wheel-only WebP animations.
// The large immutable files remain in the reviewed artwork output directory
// until the dedicated roulette asset release is published. Runtime code must
// use the digest and byte size below, never a mutable filename alone.
export const NATIVE_ROULETTE_ASSETS=Object.freeze([
  Object.freeze({
    key:'roulette_navy_gold_v1',
    displayName:'네이비 · 골드',
    fileName:'roulette-01-navy-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-01-navy-gold.webp',
    previewByteSize:61_282,
    previewSha256:'2c4f45de0b1d4928bf08aaa8cd62f1869e57d25bcaa25a09ca8f0556e9a3ae71',
    contentSha256:'5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13',
    byteSize:5_686_510,
    swatch:['#0b1f44','#dca92f']
  }),
  Object.freeze({
    key:'roulette_royal_purple_rose_gold_v1',
    displayName:'로열 퍼플 · 로즈 골드',
    fileName:'roulette-02-royal-purple-rose-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-02-royal-purple-rose-gold.webp',
    previewByteSize:58_830,
    previewSha256:'a682d32556c0f71a3371870bb771aec249f262f840b8da934e264a8371236303',
    contentSha256:'71ed5715e7f8b4fd0f6cfae92f6836533603828cf1a9359496faabf6f938cc07',
    byteSize:5_507_452,
    swatch:['#4a237a','#d99587']
  }),
  Object.freeze({
    key:'roulette_emerald_champagne_v1',
    displayName:'에메랄드 · 샴페인',
    fileName:'roulette-03-emerald-champagne-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-03-emerald-champagne.webp',
    previewByteSize:62_556,
    previewSha256:'65df2ee8f0d6b2bd26dc2dbc65de1cfc14b67f9c683c6e88a16398b97b85474c',
    contentSha256:'31448a0faf6ea8e9eb90cb934f02815ea565bb77969ac1e6c48752dc54e11966',
    byteSize:5_850_766,
    swatch:['#08705f','#e6c989']
  }),
  Object.freeze({
    key:'roulette_burgundy_pale_gold_v1',
    displayName:'버건디 · 페일 골드',
    fileName:'roulette-04-burgundy-pale-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-04-burgundy-pale-gold.webp',
    previewByteSize:59_042,
    previewSha256:'bf7f22fbc7fe2efb15f33f4525d7da8d244cb17534a579724fdf73d95f9dd1ed',
    contentSha256:'653f7292678be46798154b521aa653c5e9ef373e124ff95dc8f1037162ae32cd',
    byteSize:5_615_970,
    swatch:['#721f35','#ddc47c']
  }),
  Object.freeze({
    key:'roulette_graphite_cyan_v1',
    displayName:'그래파이트 · 시안',
    fileName:'roulette-05-graphite-cyan-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-05-graphite-cyan.webp',
    previewByteSize:60_236,
    previewSha256:'cebfcdde8b517c3a20454936ca841ece08ae0a618b72150f938b4a7f8a9194b5',
    contentSha256:'09288f7192cb5a9e7fd3be42805d073efe6434662f1a53a31d6c9c01edce79b5',
    byteSize:5_594_568,
    swatch:['#242a33','#1dc7d6']
  }),
  Object.freeze({
    key:'roulette_pastel_powder_blue_peach_v1',
    displayName:'파우더 블루 · 피치',
    fileName:'roulette-06-pastel-powder-blue-peach-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-06-powder-blue-peach.webp',
    previewByteSize:57_094,
    previewSha256:'55d366eac4f2dcdc56888d01ea368710184d9b566d36dc538297638732871cc0',
    contentSha256:'e0114be1f9bdf7a9ed0cee7022a6c067a7571ccd1998d1e8e4c74bd556642b75',
    byteSize:5_440_068,
    swatch:['#a9cde7','#f2b391']
  }),
  Object.freeze({
    key:'roulette_pastel_lavender_butter_v1',
    displayName:'더스티 라벤더 · 버터',
    fileName:'roulette-07-pastel-dusty-lavender-butter-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-07-lavender-butter.webp',
    previewByteSize:55_854,
    previewSha256:'345259343b656659d2592e6adaa2c0436e4f629ce925f9e5f34e8153fd805d53',
    contentSha256:'221f44f05f2ab2e812cb0998e6d29d426b78522aea70dd433413a647d7d5742d',
    byteSize:5_288_010,
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
  sourceRelativePath:`output/roulette_overlay/color_animations_wheel_centered/${asset.fileName}`
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
