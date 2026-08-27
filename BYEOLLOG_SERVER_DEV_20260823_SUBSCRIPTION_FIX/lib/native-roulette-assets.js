// Canonical source inventory for the seven final, clean-edge WebP animations.
// The large immutable files remain in the reviewed artwork output directory
// until the dedicated roulette asset release is published. Runtime code must
// use the digest and byte size below, never a mutable filename alone.
export const NATIVE_ROULETTE_ASSETS=Object.freeze([
  Object.freeze({
    key:'roulette_navy_gold_v1',
    displayName:'네이비 · 골드',
    fileName:'roulette-01-navy-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-01-navy-gold.png',
    previewByteSize:492_558,
    previewSha256:'591892f8be91a8a3fe880d85f0a588e8c76d304a7853bc3da96c6af64eaf1f6f',
    contentSha256:'8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',
    byteSize:25_698_598,
    swatch:['#0b1f44','#dca92f']
  }),
  Object.freeze({
    key:'roulette_royal_purple_rose_gold_v1',
    displayName:'로열 퍼플 · 로즈 골드',
    fileName:'roulette-02-royal-purple-rose-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-02-royal-purple-rose-gold.png',
    previewByteSize:428_385,
    previewSha256:'d2df884c18c580a4a4ae2798f816f90442429167da560728949c22bbc803a2ed',
    contentSha256:'7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b',
    byteSize:22_339_256,
    swatch:['#4a237a','#d99587']
  }),
  Object.freeze({
    key:'roulette_emerald_champagne_v1',
    displayName:'에메랄드 · 샴페인',
    fileName:'roulette-03-emerald-champagne-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-03-emerald-champagne.png',
    previewByteSize:421_844,
    previewSha256:'f03694c70340447727be18181802f7408552ad90e3765c30692841969a31b169',
    contentSha256:'69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed',
    byteSize:22_276_620,
    swatch:['#08705f','#e6c989']
  }),
  Object.freeze({
    key:'roulette_burgundy_pale_gold_v1',
    displayName:'버건디 · 페일 골드',
    fileName:'roulette-04-burgundy-pale-gold-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-04-burgundy-pale-gold.png',
    previewByteSize:417_127,
    previewSha256:'6c692a1a6c7b0410a4673249bec4359727d85338b68ce697b3c006eefe9319a8',
    contentSha256:'ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f',
    byteSize:21_504_782,
    swatch:['#721f35','#ddc47c']
  }),
  Object.freeze({
    key:'roulette_graphite_cyan_v1',
    displayName:'그래파이트 · 시안',
    fileName:'roulette-05-graphite-cyan-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-05-graphite-cyan.png',
    previewByteSize:412_253,
    previewSha256:'c8825333e3a9a3700bd35869bb046b1213d62783d2be5dcf191d88df5a1da6ca',
    contentSha256:'68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77',
    byteSize:21_478_638,
    swatch:['#242a33','#1dc7d6']
  }),
  Object.freeze({
    key:'roulette_pastel_powder_blue_peach_v1',
    displayName:'파우더 블루 · 피치',
    fileName:'roulette-06-pastel-powder-blue-peach-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-06-powder-blue-peach.png',
    previewByteSize:434_206,
    previewSha256:'b5bc9e94c63fd439e0d336510d056250848d0eeb68139f2429fb7908a1d7cc2a',
    contentSha256:'466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7',
    byteSize:22_176_726,
    swatch:['#a9cde7','#f2b391']
  }),
  Object.freeze({
    key:'roulette_pastel_lavender_butter_v1',
    displayName:'더스티 라벤더 · 버터',
    fileName:'roulette-07-pastel-dusty-lavender-butter-clean-edge.webp',
    previewUrl:'/assets/roulette-previews/roulette-07-lavender-butter.png',
    previewByteSize:430_540,
    previewSha256:'dd9c2aecbb0f08953479cab8d83a3ffb3280514a5f067ecb1ac89f823abe9ccd',
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
  deliveryStatus:'staged',
  sourceRelativePath:`output/roulette_overlay/color_animations_clean_edge/${asset.fileName}`
})));

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
    deliveryStatus:asset.deliveryStatus,
    swatch:[...asset.swatch]
  };
}
