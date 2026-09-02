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
    previewByteSize:60_736,
    previewSha256:'e7533d8e3b2a0b7640905d8ac1af6a95dad7a14e7a94dbbc931c406ef66b5d9d',
    contentSha256:'11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d',
    byteSize:5_646_192,
    swatch:['#0b1f44','#dca92f']
  }),
  Object.freeze({
    key:'roulette_royal_purple_rose_gold_v1',
    displayName:'로열 퍼플 · 로즈 골드',
    fileName:'roulette-02-royal-purple-rose-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-02-royal-purple-rose-gold.webp',
    previewByteSize:57_922,
    previewSha256:'fc67d3eff80189669abfadc5884d024362e22d829c9da6584c7894e55e9360d7',
    contentSha256:'9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a',
    byteSize:5_535_112,
    swatch:['#4a237a','#d99587']
  }),
  Object.freeze({
    key:'roulette_emerald_champagne_v1',
    displayName:'에메랄드 · 샴페인',
    fileName:'roulette-03-emerald-champagne-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-03-emerald-champagne.webp',
    previewByteSize:61_796,
    previewSha256:'8a459e1afac16125941c6c9ff39a887a110bcb5c9192562b6f97be6b758cb960',
    contentSha256:'0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498',
    byteSize:5_831_094,
    swatch:['#08705f','#e6c989']
  }),
  Object.freeze({
    key:'roulette_burgundy_pale_gold_v1',
    displayName:'버건디 · 페일 골드',
    fileName:'roulette-04-burgundy-pale-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-04-burgundy-pale-gold.webp',
    previewByteSize:58_302,
    previewSha256:'f40c7ef5c5ef3e10f717ea9a86228f47a722345c153d4d6d6241336a4fd59563',
    contentSha256:'168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69',
    byteSize:5_555_386,
    swatch:['#721f35','#ddc47c']
  }),
  Object.freeze({
    key:'roulette_graphite_cyan_v1',
    displayName:'그래파이트 · 시안',
    fileName:'roulette-05-graphite-cyan-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-05-graphite-cyan.webp',
    previewByteSize:58_852,
    previewSha256:'752ed5270cbd9e50a135e241d2f4ed59ad589d5d6f73092492e260c08a4cb99d',
    contentSha256:'05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf',
    byteSize:5_564_130,
    swatch:['#242a33','#1dc7d6']
  }),
  Object.freeze({
    key:'roulette_pastel_powder_blue_peach_v1',
    displayName:'파우더 블루 · 피치',
    fileName:'roulette-06-pastel-powder-blue-peach-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-06-powder-blue-peach.webp',
    previewByteSize:55_668,
    previewSha256:'20bcb116644c914b2762dddddb4cdcb23ed2aa10fb13fb32402e219c4a89ab39',
    contentSha256:'8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf',
    byteSize:5_443_906,
    swatch:['#a9cde7','#f2b391']
  }),
  Object.freeze({
    key:'roulette_pastel_lavender_butter_v1',
    displayName:'더스티 라벤더 · 버터',
    fileName:'roulette-07-pastel-dusty-lavender-butter-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-07-lavender-butter.webp',
    previewByteSize:55_012,
    previewSha256:'7b445c31b2c697ceeacc5975cffebb4b770e188f370ad729294d86c9e8c0c7ea',
    contentSha256:'07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8',
    byteSize:5_275_120,
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
  sourceRelativePath:`output/roulette_overlay/color_animations_wheel_only/${asset.fileName}`
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
