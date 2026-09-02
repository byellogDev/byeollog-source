import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {normalizeSignatureBalloonInput} from '../lib/signature-balloon-registry.js';
import {buildSignatureWallpaperBuffer} from '../lib/signature-balloon-assets.js';
import {inspectRouletteImageBytes} from '../lib/roulette-custom-assets.js';
import {normalizeSoopCeremonyImageUrl} from '../lib/native-roulette.js';
import {normalizeSoopChatSdkCallback} from '../lib/soop-chat-gateway.js';
import {resolveCeremonyForOverlay,soopDefaultCeremonyImageUrl} from '../lib/soop-roulette-service.js';
import {normalizeDefaultDonationImageInput} from '../lib/default-donation-images.js';

const workspaceId='10000000-0000-4000-8000-000000000001';
const image=(kind)=>({
  storagePath:`workspaces/${workspaceId}/${kind}/asset.webp`,
  mimeType:'image/webp',byteSize:12345,width:kind==='pc'?195:293,height:kind==='pc'?145:248,
  sha256:'a'.repeat(64)
});

test('signature registration accepts ceremony images but never accepts a user-selected wallpaper asset',()=>{
  const normalized=normalizeSignatureBalloonInput({balloonCount:33,pcImage:image('pc'),mobileImage:image('mobile'),wallpaperImage:image('wallpaper')},workspaceId);
  assert.equal(normalized.balloonCount,33);
  assert.equal(normalized.displayName,'별풍선 33개');
  assert.equal(normalized.wallpaperImage,null);
  assert.throws(()=>normalizeSignatureBalloonInput({balloonCount:33.5,pcImage:image('pc'),mobileImage:image('mobile')},workspaceId),/정수/);
  assert.throws(()=>normalizeSignatureBalloonInput({balloonCount:33,pcImage:image('mobile'),mobileImage:image('mobile')},workspaceId),/다른 워크스페이스 또는 용도/);
  assert.throws(()=>normalizeSignatureBalloonInput({balloonCount:33,pcImage:image('pc')},workspaceId),/모바일 이미지를 등록/);
});

test('wallpaper derivative is a standard transparent 320x240 WebP made only from the uploaded source',async()=>{
  const source=await readFile(new URL('../assets/roulette-previews/roulette-01-navy-gold.png',import.meta.url));
  const output=await buildSignatureWallpaperBuffer(source);
  const inspected=inspectRouletteImageBytes(output);
  assert.deepEqual([inspected.mimeType,inspected.width,inspected.height],['image/webp',320,240]);
});

test('SOOP ceremony URL upgrades provider HTTP variants and accepts only trusted asset hosts',()=>{
  assert.equal(normalizeSoopCeremonyImageUrl('https://static.file.sooplive.com/path/balloon.png'),'https://static.file.sooplive.com/path/balloon.png');
  assert.equal(normalizeSoopCeremonyImageUrl('http://static.file.sooplive.com/path/balloon.png'),'https://static.file.sooplive.com/path/balloon.png');
  assert.equal(normalizeSoopCeremonyImageUrl('//static.file.sooplive.com/path/balloon.png'),'https://static.file.sooplive.com/path/balloon.png');
  assert.equal(normalizeSoopCeremonyImageUrl('/images/chat/mission/challenge.png'),'https://res.sooplive.com/images/chat/mission/challenge.png');
  assert.equal(normalizeSoopCeremonyImageUrl('/new_player/items/ba_step2.png'),'https://res.sooplive.com/new_player/items/ba_step2.png');
  assert.equal(normalizeSoopCeremonyImageUrl('https://example.com/balloon.png'),null);
  assert.equal(normalizeSoopCeremonyImageUrl('https://user:pass@static.file.sooplive.com/path.png'),null);
});

test('SOOP chat SDK donation retains the provider ceremony image URL',()=>{
  const relay=normalizeSoopChatSdkCallback({
    action:'BALLOON_GIFTED',receivedAt:'2026-08-29T03:00:00.100Z',connection:{id:'instance:1',sequence:1,reconnectCount:0},
    message:{transactionId:'donation-1',userId:'viewer',userNickname:'시청자',count:33,imageUrl:'https://static.file.sooplive.com/path/balloon.png'}
  });
  assert.equal(relay.relay.eventType,'donation');
  assert.equal(relay.relay.event.donationTypeLabel,'별풍선');
  assert.equal(relay.relay.event.ceremonyImageUrl,'https://static.file.sooplive.com/path/balloon.png');
});

test('common overlay resolves signature, event image, workspace range, then official SOOP default',async()=>{
  const signature=await resolveCeremonyForOverlay(workspaceId,{source:'signature',asset:image('pc'),providerUrl:'https://static.file.sooplive.com/path/balloon.png'},{amount:33,hydrate:async()=>({...image('pc'),previewUrl:'https://private.example/signed'})});
  assert.deepEqual(signature,{source:'signature',url:'https://private.example/signed',providerFallbackUrl:'https://static.file.sooplive.com/path/balloon.png',defaultFallbackUrl:'https://res.sooplive.com/new_player/items/ba_step2.png'});
  const soop=await resolveCeremonyForOverlay(workspaceId,{source:'soop',url:'https://static.file.sooplive.com/path/balloon.png'},{amount:330});
  assert.deepEqual(soop,{source:'soop',url:'https://static.file.sooplive.com/path/balloon.png',providerFallbackUrl:null,defaultFallbackUrl:'https://res.sooplive.com/new_player/items/ba_step4.png'});
  const custom=await resolveCeremonyForOverlay(workspaceId,{source:'none'},{amount:50,sbImpl:async table=>table==='byeollog_default_donation_images'?[{pc_image:image('default-pc')}]:[],hydrate:async(_workspace,asset)=>({...asset,previewUrl:'https://private.example/default'})});
  assert.deepEqual(custom,{source:'workspace_default',url:'https://private.example/default',providerFallbackUrl:null,defaultFallbackUrl:'https://res.sooplive.com/new_player/items/ba_step2.png'});
  const fallback=await resolveCeremonyForOverlay(workspaceId,{source:'soop',url:'https://example.com/untrusted.png'},{amount:1001,sbImpl:async()=>[]});
  assert.deepEqual(fallback,{source:'soop_default',url:'https://res.sooplive.com/new_player/items/ba_step6.png',providerFallbackUrl:null,defaultFallbackUrl:null});
});

test('default donation image ranges validate one scoped upload and ignore client wallpaper references',()=>{
  const normalized=normalizeDefaultDonationImageInput({minAmount:1,maxAmount:99,pcImage:image('default-pc'),wallpaperImage:image('default-wallpaper')},workspaceId);
  assert.deepEqual([normalized.minAmount,normalized.maxAmount],[1,99]);
  assert.equal(normalized.wallpaperImage,null);
  assert.throws(()=>normalizeDefaultDonationImageInput({minAmount:100,maxAmount:99,pcImage:image('default-pc')},workspaceId),/작을 수 없습니다/);
  assert.throws(()=>normalizeDefaultDonationImageInput({minAmount:1,maxAmount:99,pcImage:image('pc')},workspaceId),/다른 워크스페이스 또는 용도/);
});

test('official SOOP default ceremony tiers cover every positive donation count',()=>{
  for(const [amount,file] of [[1,'ba_step2.png'],[50,'ba_step2.png'],[51,'ba_step3.png'],[100,'ba_step3.png'],[101,'ba_step4.png'],[500,'ba_step4.png'],[501,'ba_step5.png'],[1000,'ba_step5.png'],[1001,'ba_step6.png'],[30000,'ba_step6.png']]){
    assert.equal(soopDefaultCeremonyImageUrl(amount),'https://res.sooplive.com/new_player/items/'+file);
  }
});

test('database migration enforces exact-count signature priority and service-only access',async()=>{
  const registry=await readFile(new URL('../supabase/migrations/20260829031658_add_signature_balloon_registry.sql',import.meta.url),'utf8');
  const common=await readFile(new URL('../supabase/migrations/20260829121302_add_signature_wallpaper_asset.sql',import.meta.url),'utf8');
  assert.match(registry,/unique\(workspace_id,balloon_count\)/i);
  assert.match(registry,/enable row level security/i);
  assert.match(registry,/grant select,insert,update,delete[\s\S]*to service_role/i);
  assert.doesNotMatch(registry,/grant [^;]+ to anon|grant [^;]+ to authenticated/i);
  assert.match(common,/ingest_native_overlay_soop_donation_v3/i);
  assert.match(common,/add column if not exists wallpaper_image jsonb/i);
  assert.match(common,/p_kind in \('pc','mobile','wallpaper'\)/i);
  assert.match(common,/from public\.byeollog_signature_balloons[\s\S]*balloon_count=p_amount::integer/i);
  assert.match(common,/when v_signature is not null[\s\S]*providerUrl[\s\S]*when p_ceremony_image_url is not null[\s\S]*source','none'/i);
  assert.doesNotMatch(common,/soop-default-balloon/i);
  assert.match(common,/donation_ceremony/i);
});

test('default image migrations keep ranges private while limiting custom images to the common overlay',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260902150936_add_default_donation_image_ranges.sql',import.meta.url),'utf8');
  const followup=await readFile(new URL('../supabase/migrations/20260902154301_stop_default_donation_wallpaper_assets.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_default_donation_images/i);
  assert.match(sql,/pg_advisory_xact_lock/i);
  assert.match(sql,/int4range\(existing\.min_amount,existing\.max_amount,'\[\]'\)[\s\S]*&&/i);
  assert.match(sql,/bump_wallpaper_for_default_image_v1/i);
  assert.match(sql,/defaultDonationImages/i);
  assert.match(sql,/default-wallpaper/i);
  assert.match(sql,/enable row level security/i);
  assert.doesNotMatch(sql,/grant [^;]+ to anon/i);
  assert.match(followup,/alter column wallpaper_image drop not null/i);
  assert.match(followup,/set wallpaper_image=null/i);
  assert.match(followup,/drop trigger if exists bump_wallpaper_for_default_image_v1/i);
  assert.doesNotMatch(followup,/defaultDonationImages/i);
  assert.match(followup,/return public\.g3a_get_wallpaper_snapshot_v1/i);
});
