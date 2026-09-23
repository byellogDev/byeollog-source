import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canUseSoopEventImage,loadWallpaperState} from '../../apps/web/lib/wallpaper-service.js';

test('wallpaper migration records only production donations with deterministic priority and retention',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830175652_live_wallpaper_ledger.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_wallpaper_sessions/i);
  assert.match(sql,/create table public\.byeollog_wallpaper_tiles/i);
  assert.match(sql,/customSingleImage[\s\S]*customSeriesImage[\s\S]*wallpaper_image[\s\S]*p_ceremony_image_url[\s\S]*soop_default/i);
  assert.match(sql,/interval '12 hours'/i);
  assert.match(sql,/interval '30 days'/i);
  assert.match(sql,/on conflict\(workspace_id,donation_event_id\) do nothing/i);
  assert.match(sql,/ingest_native_overlay_soop_donation_v6/i);
  assert.doesNotMatch(sql,/enqueue_native_overlay_donation_test_v\d+[\s\S]*record_wallpaper/i);
});

test('manual wallpaper layout migration is additive, bounded, authorized, and revision guarded',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830181831_wallpaper_manual_layout.sql',import.meta.url),'utf8');
  assert.match(sql,/alter table public\.byeollog_wallpaper_tiles[\s\S]*add column layout_x/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_layout_v1/i);
  assert.match(sql,/assert_native_roulette_member_v1/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/layout_x \+ layout_width <= 1920/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_layout_v1[\s\S]*grant execute[\s\S]*service_role/i);
});

test('broadcast-round migration is multi-select, server-partitioned, and backfills only real Hurogi events',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830183628_wallpaper_broadcast_rounds.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_wallpaper_overlay_sessions/i);
  assert.match(sql,/create or replace function public\.select_wallpaper_sessions_v1/i);
  assert.match(sql,/create or replace function public\.ingest_native_overlay_soop_donation_v7/i);
  assert.match(sql,/p_broadcast_key/i);
  assert.match(sql,/workspace\.slug='observer_a'[\s\S]*event\.is_test=false/i);
  assert.match(sql,/2026-08-30 03:00\+00/i);
  assert.match(sql,/jsonb_array_length\(p_tiles\)>216/i);
});

test('wallpaper asset repair restores recorded SOOP images without overriding roulette or signatures',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830184706_repair_wallpaper_assets.sql',import.meta.url),'utf8');
  assert.match(sql,/raw_payload->>'img'/i);
  assert.match(sql,/tile\.asset_source='soop_default'/i);
  assert.match(sql,/source_key like 'backfill:2026-08-30:%'/i);
  assert.match(sql,/asset_source='soop'/i);
  assert.match(sql,/set statement_timeout='5s'/i);
});

test('wallpaper visibility and next-column capacity migration is persistent and revision guarded',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830210648_wallpaper_visibility_and_capacity.sql',import.meta.url),'utf8');
  assert.match(sql,/add column layout_columns/i);
  assert.match(sql,/add column layout_rows/i);
  assert.match(sql,/add column hide_below/i);
  assert.match(sql,/add column hidden_amounts/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_visibility_v1/i);
  assert.match(sql,/assert_native_roulette_member_v1/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/layout_columns=tile\.columns[\s\S]*layout_rows=tile\.rows/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_visibility_v1[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper merge and live-session migration is user-scoped, service-only, and reconnects for 20 minutes',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830213711_wallpaper_merge_live_sessions_latest_assets.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_wallpaper_user_settings/i);
  assert.match(sql,/alter table public\.byeollog_wallpaper_user_settings enable row level security/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_merge_rules_v1/i);
  assert.match(sql,/assert_native_roulette_member_v1/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/create table public\.byeollog_wallpaper_release_observations/i);
  assert.match(sql,/gateway\.state='connected'[\s\S]*interval '45 seconds'/i);
  assert.match(sql,/interval '20 minutes'/i);
  assert.match(sql,/create or replace function public\.ingest_native_overlay_soop_donation_v8/i);
  assert.match(sql,/label='08월 30일 12:00 방송'/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_merge_rules_v1[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper round start follows the live connection instead of the first donation',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260831142517_wallpaper_broadcast_connection_start_time.sql',import.meta.url),'utf8');
  const gateway=await readFile(auditURL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
  assert.match(sql,/select gateway\.chat_number,gateway\.connected_at/i);
  assert.match(sql,/v_started_at:=date_trunc\('minute',v_gateway_connected_at\)/i);
  assert.match(sql,/v_gateway_connected_at>='2026-08-31 14:25:00\+00'/i);
  assert.match(sql,/started_at=least\(session\.started_at,v_started_at\)/i);
  assert.match(sql,/interval '20 minutes'/i);
  assert.match(sql,/label='08월 31일 19:00 방송'/i);
  assert.match(sql,/revoke all on function public\.ensure_wallpaper_broadcast_session_v2[\s\S]*grant execute[\s\S]*service_role/i);
  assert.match(gateway,/connectedAt:connected\?connectedAt:null/i);
  assert.match(gateway,/reconnectGap>20\*60_000/i);
  assert.doesNotMatch(gateway,/connectedAt:connected\?startedAt:null/i);
});

test('verified SOOP room identity repairs heartbeat gaps without becoming a permanent broadcast key',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260907232120_canonicalize_wallpaper_session_from_verified_room.sql',import.meta.url),'utf8');
  assert.match(sql,/create or replace function public\.ensure_wallpaper_broadcast_session_v3/i);
  assert.match(sql,/v_effective_key:='soop-chat:'\|\|p_source_chat_number::text/i);
  assert.match(sql,/record_wallpaper_donation_v5[\s\S]*ensure_wallpaper_broadcast_session_v3\([\s\S]*p_source_chat_number/i);
  assert.doesNotMatch(sql,/gateway\.heartbeat_at[\s\S]*interval '45 seconds'/i);
  assert.match(sql,/pg_advisory_xact_lock/i);
  assert.match(sql,/revoke all on function public\.ensure_wallpaper_broadcast_session_v3[\s\S]*grant execute[\s\S]*service_role/i);
});

test('server-issued SOOP broadcast instances survive reconnects but rotate after a confirmed offline gap',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260907235900_issue_persistent_soop_broadcast_instances.sql',import.meta.url),'utf8');
  assert.match(sql,/add column if not exists broadcast_instance_id uuid/i);
  assert.match(sql,/add column if not exists last_live_chat_number bigint/i);
  assert.match(sql,/add column if not exists broadcast_offline_since timestamptz/i);
  assert.match(sql,/create trigger track_soop_broadcast_instance_v1/i);
  assert.match(sql,/old\.last_live_chat_number is distinct from new\.chat_number/i);
  assert.match(sql,/v_now-old\.broadcast_offline_since>interval '20 minutes'/i);
  assert.match(sql,/create or replace function public\.claim_soop_broadcast_instance_v1/i);
  assert.match(sql,/v_effective_key:='soop-broadcast:'\|\|v_broadcast_instance_id::text/i);
  assert.doesNotMatch(sql,/v_effective_key:='soop-chat:'/i);
  assert.match(sql,/record_wallpaper_donation_v5[\s\S]*ensure_wallpaper_broadcast_session_v4\([\s\S]*p_provider_bj_id[\s\S]*p_source_chat_number/i);
  assert.match(sql,/revoke all on function public\.claim_soop_broadcast_instance_v1[\s\S]*grant execute[\s\S]*service_role/i);
  assert.match(sql,/revoke all on function public\.ensure_wallpaper_broadcast_session_v4[\s\S]*grant execute[\s\S]*service_role/i);
});

test('historical wallpaper sessions remain selectable while SOOP event images stay current-session only',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260904234500_allow_historical_wallpaper_sessions_without_soop_event_images.sql',import.meta.url),'utf8');
  assert.equal(canUseSoopEventImage({session_id:'current'},'current'),true);
  assert.equal(canUseSoopEventImage({session_id:'previous'},'current'),false);
  assert.match(sql,/select count\(\*\)[\s\S]*session\.id=any\(p_session_ids\)/i);
  assert.doesNotMatch(sql,/closed_at[\s\S]*interval '24 hours'/i);
  assert.match(sql,/cron\.unschedule/i);
  assert.match(sql,/drop function if exists private\.prune_expired_wallpaper_session_selections_v1/i);
  assert.doesNotMatch(sql,/delete from public\.byeollog_wallpaper_tiles/i);
});

test('SOOP event wallpaper images require a fresh room claimed by exactly one workspace',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260906140644_isolate_wallpaper_provider_images_by_live_room.sql',import.meta.url),'utf8');
  assert.match(sql,/gateway\.workspace_id=p_workspace_id[\s\S]*gateway\.state='connected'/i);
  assert.match(sql,/gateway\.heartbeat_at>=clock_timestamp\(\)-interval '45 seconds'/i);
  assert.match(sql,/other\.workspace_id<>p_workspace_id[\s\S]*other\.chat_number=v_room_chat_number/i);
  assert.match(sql,/not exists\([\s\S]*other\.heartbeat_at>=clock_timestamp\(\)-interval '45 seconds'/i);
  assert.match(sql,/'roomChatNumber',v_room_chat_number[\s\S]*'workspaceId',p_workspace_id/i);
  assert.match(sql,/if v_asset is null then[\s\S]*v_source:='soop_default'/i);
  assert.match(sql,/revoke all on function byeollog_automation\.record_wallpaper_donation_v4[\s\S]*public,anon,authenticated,service_role/i);
});

test('historical cards use registered defaults instead of their recorded SOOP event image URL',async()=>{
  const current='20000000-0000-4000-8000-000000000020';
  const previous='20000000-0000-4000-8000-000000000019';
  const sbImpl=async(table)=>{
    if(table==='byeollog_wallpaper_sessions')return [
      {id:current,label:'현재 방송',state:'active',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-09-04T00:00:00Z'},
      {id:previous,label:'이전 방송',state:'closed',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-08-01T00:00:00Z',closed_at:'2026-08-01T03:00:00Z'}
    ];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:2,visible_group_keys:['donation:100','donation:200','donation:500']}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [{session_id:previous,position:0},{session_id:current,position:1}];
    if(table==='byeollog_soop_gateway_sessions')return [];
    if(table==='byeollog_wallpaper_tiles')return [
      {id:'old',session_id:previous,sequence_no:1,actor_name:'이전 후원',amount:200,display_kind:'donation',asset_source:'soop',asset:{url:'https://static.file.sooplive.com/previous-event.png'},received_at:'2026-08-01T01:00:00Z'},
      {id:'old-without-owned-image',session_id:previous,sequence_no:2,actor_name:'이전 후원 2',amount:500,display_kind:'donation',asset_source:'soop',asset:{url:'https://static.file.sooplive.com/previous-500.png'},received_at:'2026-08-01T01:01:00Z'},
      {id:'new',session_id:current,sequence_no:2,actor_name:'현재 후원',amount:100,display_kind:'donation',asset_source:'soop',asset:{url:'https://static.file.sooplive.com/current-event.png'},received_at:'2026-09-04T01:00:00Z'}
    ];
    if(table==='byeollog_signature_balloons')return [];
    if(table==='byeollog_default_donation_images')return [{min_amount:200,max_amount:200,pc_image:{storagePath:'defaults/200.png'}}];
    throw new Error(`unexpected ${table}`);
  };
  const state=await loadWallpaperState('10000000-0000-4000-8000-000000000001',{
    sbImpl,
    hydrateSignatureAssetPreviewsImpl:async()=>[{previewUrl:'https://signed.byeollog.test/default-200.png'}],
    now:Date.parse('2026-09-04T02:00:00Z')
  });
  const cards=state.groups.flatMap(group=>group.cards);
  const old=cards.find(card=>card.id==='old'),oldWithoutOwnedImage=cards.find(card=>card.id==='old-without-owned-image'),currentCard=cards.find(card=>card.id==='new');
  assert.equal(state.sessions.length,2);
  assert.deepEqual(state.selectedSessionIds,[previous,current]);
  assert.equal(old.imageUrl,'https://signed.byeollog.test/default-200.png');
  assert.equal(old.source,'workspace_default');
  assert.notEqual(old.imageUrl,'https://static.file.sooplive.com/previous-event.png');
  assert.equal(oldWithoutOwnedImage.imageUrl,null);
  assert.equal(oldWithoutOwnedImage.imageKey,null);
  assert.equal(oldWithoutOwnedImage.source,'none');
  assert.equal(currentCard.imageUrl,'https://static.file.sooplive.com/current-event.png');
  assert.equal(currentCard.source,'soop');
});

test('combined rounds keep the first selected round as the layout owner',async()=>{
  const recent='20000000-0000-4000-8000-000000000030';
  const previous='20000000-0000-4000-8000-000000000029';
  const recentLayout={layout_x:280,layout_y:762,layout_width:480,layout_height:180,layout_columns:4,layout_rows:3,layout_next_side:'right',layout_layer:2};
  const previousLayout={layout_x:40,layout_y:120,layout_width:960,layout_height:640,layout_columns:5,layout_rows:10,layout_next_side:'left',layout_layer:7};
  const sbImpl=async table=>{
    if(table==='byeollog_wallpaper_sessions')return [
      {id:recent,label:'최근 방송',state:'active',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-09-07T10:00:00Z'},
      {id:previous,label:'이전 방송',state:'closed',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-09-03T08:00:00Z'}
    ];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:3,visible_group_keys:['donation:33'],merge_ranges:[]}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [{session_id:recent,position:0},{session_id:previous,position:1}];
    if(table==='byeollog_soop_gateway_sessions'||table==='byeollog_signature_balloons'||table==='byeollog_default_donation_images')return [];
    if(table==='byeollog_wallpaper_tiles')return [
      {id:'recent-card',session_id:recent,sequence_no:2,actor_name:'최근 후원',amount:33,display_kind:'donation',asset_source:'soop_default',asset:{},received_at:'2026-09-07T10:01:00Z',...recentLayout},
      {id:'old-card',session_id:previous,sequence_no:1,actor_name:'이전 후원',amount:33,display_kind:'donation',asset_source:'soop_default',asset:{},received_at:'2026-09-03T08:01:00Z',...previousLayout}
    ];
    throw new Error(`unexpected ${table}`);
  };
  const state=await loadWallpaperState('10000000-0000-4000-8000-000000000001',{sbImpl,now:Date.parse('2026-09-07T10:02:00Z')});
  assert.equal(state.groups.length,1);
  assert.equal(state.groups[0].layoutPriority,0);
  assert.deepEqual([state.groups[0].x,state.groups[0].y,state.groups[0].layer,state.groups[0].nextSide],[280,762,2,'right']);
});

test('wallpaper next-column side is persisted by a revision-guarded service-only RPC',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830221708_wallpaper_next_side_live_layout.sql',import.meta.url),'utf8');
  assert.match(sql,/add column layout_next_side/i);
  assert.match(sql,/layout_next_side in \('left','right'\)/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v2/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/layout_next_side=tile\.next_side/i);
  assert.match(sql,/layout_next_side=null/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_overlay_layout_v2[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper size ranges persist per user and activate through a revision-guarded service-only RPC',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260901215735_wallpaper_persistent_size_ranges.sql',import.meta.url),'utf8');
  assert.match(sql,/byeollog_wallpaper_overlay_states[\s\S]*add column size_ranges jsonb/i);
  assert.match(sql,/byeollog_wallpaper_user_settings[\s\S]*add column size_ranges jsonb/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_size_rules_v1/i);
  assert.match(sql,/assert_native_roulette_member_v1/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/is_valid_wallpaper_size_ranges_v1/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_size_rules_v1[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper off-canvas migration keeps a bounded editor margin around the OBS frame',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260831153000_wallpaper_off_canvas_layout.sql',import.meta.url),'utf8');
  assert.match(sql,/drop constraint if exists byeollog_wallpaper_tiles_layout_bounds_check/i);
  assert.match(sql,/layout_x >= -160[\s\S]*layout_y >= -90/i);
  assert.match(sql,/layout_x \+ layout_width <= 2080[\s\S]*layout_y \+ layout_height <= 1170/i);
  assert.match(sql,/\(item->>'x'\)!~'\^-\?\[0-9\]\+\$'/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v2/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_overlay_layout_v2[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper off-canvas rollback clamps saved layouts and restores strict OBS bounds',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260901000734_rollback_wallpaper_off_canvas_layout.sql',import.meta.url),'utf8');
  assert.match(sql,/greatest\(0,least\(layout_x,1920-least\(layout_width,1920\)\)\)/i);
  assert.match(sql,/greatest\(0,least\(layout_y,1080-least\(layout_height,1080\)\)\)/i);
  assert.match(sql,/layout_x >= 0[\s\S]*layout_y >= 0/i);
  assert.match(sql,/layout_x \+ layout_width <= 1920[\s\S]*layout_y \+ layout_height <= 1080/i);
  assert.match(sql,/\(item->>'x'\)!~'\^\[0-9\]\+\$'/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v2/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_overlay_layout_v2[\s\S]*grant execute[\s\S]*service_role/i);
});

test('successful challenge missions are captured without changing the Agent and Hurogi Aug 30 is backfilled',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830222704_wallpaper_challenge_success_cards.sql',import.meta.url),'utf8');
  assert.match(sql,/add column display_kind/i);
  assert.match(sql,/display_kind in \('donation','challenge_success'\)/i);
  assert.match(sql,/after insert on public\.bangsel_donations/i);
  assert.match(sql,/new\.donation_type<>'도전성공'[\s\S]*new\.soop_id<>'__challenge_settle__'/i);
  assert.match(sql,/new\.donated_at<clock_timestamp\(\)-interval '2 hours'/i);
  assert.match(sql,/m_challenge_mission_settle_01\.png/i);
  assert.match(sql,/broadcast:observer_a:2026-08-30-1200/i);
  assert.match(sql,/revoke all on function byeollog_automation\.capture_wallpaper_challenge_success_v1\(\)[\s\S]*public,anon,authenticated,service_role/i);
});

test('fresh Collector subscriptions preserve allow-listed SOOP official wallpaper images',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260831211707_wallpaper_subscription_cards.sql',import.meta.url),'utf8');
  const backfill=await readFile(auditURL('../supabase/migrations/20260831214059_backfill_matchable_wallpaper_subscriptions.sql',import.meta.url),'utf8');
  const officialImage=await readFile(auditURL('../supabase/migrations/20260831222902_wallpaper_subscription_official_image.sql',import.meta.url),'utf8');
  assert.match(sql,/display_kind in \('donation','challenge_success','subscription'\)/i);
  assert.match(sql,/asset_source in \('roulette','signature','soop','soop_default','none'\)/i);
  assert.match(sql,/after insert or update[\s\S]*on public\.bangsel_collector_staging/i);
  assert.match(sql,/new\.validation<>'subscription'/i);
  assert.match(sql,/subscription_months/i);
  assert.match(sql,/wallpaper-subscription:/i);
  assert.match(sql,/on conflict\(workspace_id,donation_event_id\) do nothing/i);
  assert.match(sql,/ensure_wallpaper_broadcast_session_v2/i);
  assert.match(sql,/interval '2 hours'/i);
  assert.match(sql,/\^\(donation\|challenge_success\|subscription\):\[1-9\]/i);
  assert.match(sql,/revoke all on function byeollog_automation\.capture_wallpaper_subscription_v1\(\)[\s\S]*public,anon,authenticated,service_role/i);
  assert.match(backfill,/join lateral[\s\S]*byeollog_wallpaper_sessions/i);
  assert.match(backfill,/on conflict\(workspace_id,donation_event_id\) do nothing/i);
  assert.doesNotMatch(backfill,/ensure_wallpaper_broadcast_session_v2/i);
  assert.match(officialImage,/raw_payload->>'imageUrl'/i);
  assert.match(officialImage,/sooplive\\\.com\|afreecatv\\\.com\|afreecatvcdn\\\.com/i);
  assert.match(officialImage,/asset_source='soop',asset=jsonb_build_object\('url',v_image_url\)/i);
  assert.match(officialImage,/collector-subscription-v2/i);
  assert.match(officialImage,/updated_tiles[\s\S]*updated_sessions[\s\S]*byeollog_wallpaper_overlay_states/i);
  assert.match(officialImage,/revoke all on function byeollog_automation\.capture_wallpaper_subscription_v1\(\)[\s\S]*public,anon,authenticated,service_role/i);
});

test('wallpaper visibility is an empty-by-default service-only allowlist',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260830223242_wallpaper_visible_allowlist.sql',import.meta.url),'utf8');
  assert.match(sql,/add column visible_group_keys text\[\][\s\S]*default '\{\}'::text\[\]/i);
  assert.match(sql,/cardinality\(visible_group_keys\)<=500/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_visible_keys_v1/i);
  assert.match(sql,/p_expected_revision[\s\S]*errcode='40001'/i);
  assert.match(sql,/\^\(donation\|challenge_success\):\[1-9\]/i);
  assert.match(sql,/hide_below=0[\s\S]*hidden_amounts='\{\}'::integer\[\]/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_visible_keys_v1[\s\S]*grant execute[\s\S]*service_role/i);
});

test('existing Agent claim carries only changed wallpaper snapshots and keeps browser data service-only',async()=>{
  const [sql,edge,shared,runtime]=await Promise.all([
    readFile(auditURL('../supabase/migrations/20260831183000_agent_wallpaper_snapshot.sql',import.meta.url),'utf8'),
    readFile(auditURL('../supabase/functions/agent-runtime/index.ts',import.meta.url),'utf8'),
    readFile(auditURL('../supabase/functions/_shared/agent-wallpaper.ts',import.meta.url),'utf8'),
    readFile(auditURL('../supabase/functions/_shared/server-runtime.ts',import.meta.url),'utf8')
  ]);
  assert.match(sql,/create or replace function public\.g3a_get_wallpaper_snapshot_v1/i);
  assert.match(sql,/perform public\.g3a_authenticate_agent_device_v1/i);
  assert.match(sql,/if p_known_revision = v_revision then[\s\S]*'changed', false/i);
  assert.match(sql,/limit 216/i);
  assert.match(sql,/revoke execute[\s\S]*public, anon, authenticated[\s\S]*grant execute[\s\S]*service_role/i);
  assert.match(edge,/knownWallpaperRevision/);
  assert.match(edge,/wallpaperSchemaVersion/);
  assert.match(edge,/rpc\/g3a_get_wallpaper_snapshot_v1/);
  assert.match(edge,/operation === "wallpaper"/);
  assert.match(edge,/operation !== "wallpaper" && operation !== "claim"/);
  assert.match(edge,/agent_wallpaper_direct_sync_failed/);
  assert.ok(edge.indexOf('rpc/g3a_claim_execution_v1')<edge.lastIndexOf('rpc/g3a_get_wallpaper_snapshot_v1'),'action claim must run before wallpaper snapshot work in the claim path');
  assert.match(edge,/if \(!item && knownWallpaperRevision !== null\)/);
  assert.match(edge,/job: null,[\s\S]*wallpaper/);
  assert.match(shared,/createServiceStorageSignedUrl\("byeollog-signature-assets"/);
  assert.match(shared,/compactAgentWallpaperState/);
  assert.match(shared,/selectedSessionPriority/);
  assert.match(shared,/layoutPriority: selectedSessionPriority\.get/);
  assert.match(shared,/const currentSessionId = safeText\(raw\.currentSessionId, 40\)/);
  assert.match(shared,/safeText\(row\.sessionId, 40\) !== currentSessionId/);
  assert.match(shared,/mayUseSoopEventImage = currentSessionId\.length > 0 && rowSessionId === currentSessionId/);
  assert.match(shared,/raw\.defaultDonationImages/);
  assert.match(shared,/workspace_default:/);
  assert.match(shared,/visibleKeys\.has\(visibilityKey\)/);
  assert.match(shared,/soop_default/);
  assert.match(shared,/mayUseSoopEventImage && \(displayKind === "challenge_success" \|\| displayKind === "subscription"\)[\s\S]*normalizeSoopUrl\(asset\?\.url\)/);
  assert.match(shared,/source: officialEventUrl \? "soop" : "none"/);
  assert.match(runtime,/relative\.startsWith\("\/object\/sign\/"\)[\s\S]*`\/storage\/v1\$\{relative\}`/);
  assert.match(runtime,/signed\.pathname !== expectedPath/);
  assert.match(runtime,/signed\.searchParams\.has\("token"\)/);
});

test('signature signing fix refreshes only cached Agent snapshots that use custom wallpapers',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260831203000_refresh_agent_signature_wallpaper_snapshots.sql',import.meta.url),'utf8');
  assert.match(sql,/update public\.byeollog_wallpaper_overlay_states/i);
  assert.match(sql,/set revision\s*=\s*overlay\.revision \+ 1/i);
  assert.match(sql,/signature\.workspace_id\s*=\s*overlay\.workspace_id/i);
  assert.match(sql,/signature\.wallpaper_image is not null/i);
});

test('legacy web wallpaper OBS page retires transparently and migrates loaded clients',async()=>{
  const login=await readFile(auditURL('../api/login.js',import.meta.url),'utf8');
  assert.match(login,/handleSoopWallpaperOverlayPage[\s\S]*status\(410\)[\s\S]*background:transparent/);
  assert.match(login,/handleSoopWallpaperState[\s\S]*status\(200\)\.json\(\{ok:false,disabled:true,reason:'moved_to_local_agent',clientVersion:'agent-only-20260831'/);
  assert.doesNotMatch(login,/loadWallpaperState\(payload\.wid/);
});

test('registered signature wallpapers keep stable asset identities when signed URLs rotate',async()=>{
  const workspaceId='10000000-0000-4000-8000-000000000001',sessionId='20000000-0000-4000-8000-000000000001';
  const sbImpl=async table=>{
    if(table==='byeollog_wallpaper_sessions')return [{id:sessionId,label:'방송',state:'active',canvas_width:1920,canvas_height:1080,tile_count:3,started_at:'2026-08-31T00:00:00Z'}];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:4,visible_group_keys:['donation:33','donation:100','donation:777'],merge_ranges:[]}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [{session_id:sessionId,position:0}];
    if(table==='byeollog_soop_gateway_sessions')return [];
    if(table==='byeollog_native_roulette_services')return [];
    if(table==='byeollog_signature_balloons')return [33,100,777].map(amount=>({balloon_count:amount,wallpaper_image:{storagePath:`workspaces/${workspaceId}/wallpaper/${amount}.webp`}}));
    if(table==='byeollog_wallpaper_tiles')return [33,100,777].map((amount,index)=>({id:`tile-${amount}`,session_id:sessionId,sequence_no:index+1,actor_name:`후원자${amount}`,amount,display_kind:'donation',asset_source:'soop',asset:{url:`https://static.file.sooplive.com/${amount}.png`},received_at:`2026-08-31T00:00:0${index}Z`,layout_x:null,layout_y:null,layout_width:null,layout_height:null}));
    throw new Error(`unexpected ${table}`);
  };
  const load=token=>loadWallpaperState(workspaceId,{sbImpl,hydrateSignatureAssetPreviewsImpl:async(_workspace,references)=>references.map(({reference})=>({...reference,previewUrl:`https://storage.example/${reference.storagePath}?token=${token}`}))});
  const first=await load('first'),second=await load('second');
  const firstCards=new Map(first.groups.flatMap(group=>group.cards).map(card=>[card.amount,card]));
  const secondCards=new Map(second.groups.flatMap(group=>group.cards).map(card=>[card.amount,card]));
  for(const amount of [33,100,777]){
    assert.equal(firstCards.get(amount).source,'signature');
    assert.notEqual(firstCards.get(amount).imageUrl,secondCards.get(amount).imageUrl);
    assert.equal(firstCards.get(amount).imageKey,`signature:workspaces/${workspaceId}/wallpaper/${amount}.webp`);
    assert.equal(firstCards.get(amount).imageKey,secondCards.get(amount).imageKey);
  }
});

test('SOOP image-free donations reuse the registered default image in wallpaper',async()=>{
  const workspaceId='10000000-0000-4000-8000-000000000001',sessionId='20000000-0000-4000-8000-000000000001';
  const reference={storagePath:`workspaces/${workspaceId}/default-pc/basic.gif`,mimeType:'image/gif'};
  const sbImpl=async table=>{
    if(table==='byeollog_wallpaper_sessions')return [{id:sessionId,label:'방송',state:'active',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-09-03T00:00:00Z'}];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:8,visible_group_keys:['donation:55'],merge_ranges:[]}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [{session_id:sessionId,position:0}];
    if(table==='byeollog_soop_gateway_sessions'||table==='byeollog_native_roulette_services'||table==='byeollog_native_roulette_activations')return [];
    if(table==='byeollog_signature_balloons')return [];
    if(table==='byeollog_default_donation_images')return [{min_amount:1,max_amount:null,pc_image:reference}];
    if(table==='byeollog_wallpaper_tiles')return [{id:'default-tile',session_id:sessionId,sequence_no:1,actor_name:'기본풍',amount:55,display_kind:'donation',asset_source:'soop_default',asset:{url:'https://res.sooplive.com/new_player/items/ba_step3.png'},received_at:'2026-09-03T00:00:01Z',layout_x:null,layout_y:null,layout_width:null,layout_height:null}];
    throw new Error(`unexpected ${table}`);
  };
  const state=await loadWallpaperState(workspaceId,{sbImpl,hydrateSignatureAssetPreviewsImpl:async(_workspace,items)=>items.map(()=>({...reference,previewUrl:'https://storage.example/default.gif?token=signed'}))});
  const card=state.groups[0].cards[0];
  assert.equal(card.source,'workspace_default');
  assert.equal(card.imageUrl,'https://storage.example/default.gif?token=signed');
  assert.equal(card.imageKey,`workspace_default:${reference.storagePath}`);
});

test('web wallpaper state exposes subscription months with the official SOOP image',async()=>{
  const workspaceId='10000000-0000-4000-8000-000000000001',sessionId='20000000-0000-4000-8000-000000000001';
  const sbImpl=async table=>{
    if(table==='byeollog_wallpaper_sessions')return [{id:sessionId,label:'방송',state:'active',canvas_width:1920,canvas_height:1080,tile_count:1,started_at:'2026-09-01T00:00:00Z'}];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:7,visible_group_keys:['subscription:6'],merge_ranges:[{min:1,max:9}]}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [{session_id:sessionId,position:0}];
    if(table==='byeollog_soop_gateway_sessions'||table==='byeollog_native_roulette_services')return [];
    if(table==='byeollog_signature_balloons')return [];
    if(table==='byeollog_wallpaper_tiles')return [{id:'subscription-tile',session_id:sessionId,sequence_no:1,actor_name:'구독자',amount:6,display_kind:'subscription',asset_source:'soop',asset:{url:'https://static.file.sooplive.com/subscription_ceremony/m/gudok_6.png'},received_at:'2026-09-01T00:00:01Z',layout_x:null,layout_y:null,layout_width:null,layout_height:null}];
    throw new Error(`unexpected ${table}`);
  };
  const state=await loadWallpaperState(workspaceId,{sbImpl});
  assert.deepEqual(state.visibility.visibleKeys,['subscription:6']);
  assert.deepEqual(state.catalog.map(item=>[item.key,item.displayKind,item.amount,item.visible]),[['subscription:6','subscription',6,true]]);
  assert.equal(state.groups.length,1);
  assert.equal(state.groups[0].id,'wallpaper-subscription-6');
  assert.equal(state.groups[0].displayKind,'subscription');
  assert.equal(state.groups[0].cards[0].imageUrl,'https://static.file.sooplive.com/subscription_ceremony/m/gudok_6.png');
  assert.equal(state.groups[0].cards[0].imageKey,'soop:https://static.file.sooplive.com/subscription_ceremony/m/gudok_6.png');
  assert.ok(state.groups[0].cardHeight>state.groups[0].rowStep);
});

test('web editor keeps official-image subscriptions at normal image-card proportions',async()=>{
  const dashboard=await readFile(auditURL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  assert.match(dashboard,/compact=!cards\.some\(card=>Boolean\(card\.imageUrl\|\|group\.imageUrl\)\)/);
  assert.doesNotMatch(dashboard,/compact=group\.displayKind==='subscription',baseCardHeight/);
});

test('Agent snapshot exposes a server-derived current round id without replacing auth logic',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260907223721_enforce_historical_wallpaper_image_policy.sql',import.meta.url),'utf8');
  assert.match(sql,/pg_get_functiondef\(target\)/i);
  assert.match(sql,/wallpaper snapshot anchor changed; refusing broad replacement/i);
  assert.match(sql,/'currentSessionId'[\s\S]*public\.byeollog_wallpaper_sessions[\s\S]*session\.workspace_id = p_workspace_id/i);
  assert.match(sql,/order by session\.started_at desc, session\.id desc/i);
  assert.match(sql,/update public\.byeollog_wallpaper_overlay_states[\s\S]*revision = revision \+ 1/i);
  assert.doesNotMatch(sql,/create or replace function public\.g3a_get_wallpaper_snapshot_v1/i);
});

test('legacy compact subscription layout repair preserves the bottom edge and wakes overlays',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260831225459_repair_subscription_official_image_layout.sql',import.meta.url),'utf8');
  assert.match(sql,/display_kind='subscription'[\s\S]*asset_source='soop'/i);
  assert.match(sql,/layout_y\+tile\.layout_height-legacy\.target_height/i);
  assert.match(sql,/revision=session\.revision\+1/i);
  assert.match(sql,/revision=overlay\.revision\+1/i);
});

test('web wallpaper state combines selected broadcast rounds and returns server-packed tiles',async()=>{
  const calls=[];
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    if(table==='byeollog_wallpaper_sessions')return [
      {id:'20000000-0000-4000-8000-000000000002',label:'08월 30일 13:00 방송 · 연결 2',state:'active',canvas_width:1920,canvas_height:1080,revision:1,tile_count:3,started_at:'2026-08-30T04:00:00Z',closed_at:null,updated_at:'2026-08-30T05:00:00Z'},
      {id:'20000000-0000-4000-8000-000000000001',label:'08월 30일 12:00 방송 · 연결 1',state:'closed',canvas_width:1920,canvas_height:1080,revision:1,tile_count:1,started_at:'2026-08-30T03:00:00Z',closed_at:'2026-08-30T04:00:00Z',updated_at:'2026-08-30T04:00:00Z'}
    ];
    if(table==='byeollog_wallpaper_overlay_states')return [{revision:9,visible_group_keys:['donation:100','challenge_success:2000'],merge_ranges:[{min:30,max:50}],size_ranges:[{min:100,max:999,width:300}],active_settings_user_id:'30000000-0000-4000-8000-000000000001',updated_at:'2026-08-31T00:01:00Z'}];
    if(table==='byeollog_wallpaper_overlay_sessions')return [
      {session_id:'20000000-0000-4000-8000-000000000001',position:0},
      {session_id:'20000000-0000-4000-8000-000000000002',position:1}
    ];
    if(table==='byeollog_soop_gateway_sessions')return [{state:'waiting_for_live',chat_number:null,heartbeat_at:new Date().toISOString()}];
    if(table==='byeollog_native_roulette_services')return [];
    if(table==='byeollog_wallpaper_user_settings')return [{merge_ranges:[{min:1,max:9}],size_ranges:[{min:1,max:99,width:180},{min:100,max:999,width:300}]}];
    if(table==='byeollog_signature_balloons')return [];
    if(table==='byeollog_wallpaper_tiles')return [
      {id:'d',session_id:'20000000-0000-4000-8000-000000000002',sequence_no:4,actor_name:'도전미션 성공',amount:2000,display_kind:'challenge_success',asset_source:'soop',asset:{url:'https://res.sooplive.com/images/chat/mission/m_challenge_mission_settle_01.png'},received_at:'2026-08-30T07:40:05Z',layout_x:1640,layout_y:880,layout_width:280,layout_height:200,layout_columns:2,layout_rows:1,layout_next_side:'right'},
      {id:'c',session_id:'20000000-0000-4000-8000-000000000002',sequence_no:3,actor_name:'최신별백개',amount:100,asset_source:'soop',asset:{url:'https://static.file.sooplive.com/latest.png'},received_at:'2026-08-30T04:00:03Z',layout_x:null,layout_y:null,layout_width:null,layout_height:null},
      {id:'b',session_id:'20000000-0000-4000-8000-000000000002',sequence_no:2,actor_name:'별백개',amount:100,asset_source:'soop',asset:{url:'https://static.file.sooplive.com/old.png'},received_at:'2026-08-30T04:00:02Z',layout_x:0,layout_y:0,layout_width:600,layout_height:420,layout_columns:3,layout_rows:2,layout_next_side:'left'},
      {id:'a',session_id:'20000000-0000-4000-8000-000000000001',sequence_no:1,actor_name:'별하나',amount:1,asset_source:'soop',asset:{url:'https://static.file.sooplive.com/a.png'},received_at:'2026-08-30T03:00:01Z',layout_x:null,layout_y:null,layout_width:null,layout_height:null}
    ];
    throw new Error(`unexpected ${table}`);
  };
  const state=await loadWallpaperState('10000000-0000-4000-8000-000000000001',{sbImpl,authorizedUserId:'30000000-0000-4000-8000-000000000001',now:Date.parse('2026-08-31T00:00:00Z')});
  assert.equal(calls.some(call=>call.table==='rpc/ensure_wallpaper_session_v1'),false);
  assert.equal(state.revision,9);
  assert.deepEqual(state.selectedSessionIds,['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002']);
  assert.equal(state.sessions.filter(item=>item.selected).length,2);
  assert.equal(state.totalTiles,4);
  assert.equal(state.tiles.length,3);
  assert.equal(state.groups.length,2);
  assert.equal(state.visibleTiles,3);
  assert.equal(state.hiddenTiles,1);
  assert.deepEqual(state.visibility,{visibleKeys:['donation:100','challenge_success:2000']});
  assert.equal(state.catalog.length,3);
  assert.equal(state.catalog.find(item=>item.key==='donation:1').visible,false);
  assert.equal(state.catalog.find(item=>item.key==='donation:100').visible,true);
  const manual=state.groups.find(group=>group.cards.some(card=>card.id==='b'));
  assert.equal(manual.cards[0].actorName,'별백개');
  assert.equal(manual.manualLayout,true);
  assert.deepEqual([manual.x,manual.y,manual.width,manual.height],[0,0,600,420]);
  assert.equal(manual.nextSide,'left');
  assert.equal(manual.direction,'rtl');
  assert.equal(state.hasManualLayout,true);
  assert.equal(state.live.isLive,false);
  assert.equal(state.sessions.some(item=>item.isLive),false);
  assert.deepEqual(state.merge.savedRules,[{min:1,max:9}]);
  assert.deepEqual(state.size.savedRules,[{min:1,max:99,width:180},{min:100,max:999,width:300}]);
  assert.deepEqual(state.size.rules,[{min:100,max:999,width:300}]);
  assert.ok(manual.cards.every(card=>card.imageUrl==='https://static.file.sooplive.com/latest.png'));
  const challenge=state.groups.find(group=>group.cards.some(card=>card.displayKind==='challenge_success'));
  assert.equal(challenge.cards[0].amount,2000);
  assert.equal(challenge.cards[0].imageUrl,'https://res.sooplive.com/images/chat/mission/m_challenge_mission_settle_01.png');
  assert.equal(challenge.manualLayout,true);
  assert.deepEqual([challenge.x,challenge.y,challenge.width,challenge.height],[1640,880,280,200]);
  assert.match(calls.find(call=>call.table==='byeollog_wallpaper_tiles').path,/display_kind/);
  assert.ok(state.tiles.every(tile=>tile.imageUrl&&Number.isFinite(tile.x)&&Number.isFinite(tile.y)));
});

test('wallpaper routes retire web editing and expose the same editor only through the local Agent bridge',async()=>{
  const [login,admin,dashboard,routes,gateway]=await Promise.all([
    readFile(auditURL('../api/login.js',import.meta.url),'utf8'),
    readFile(auditURL('../api/admin.js',import.meta.url),'utf8'),
    readFile(auditURL('../lib/product-dashboard-html.js',import.meta.url),'utf8'),
    readFile(auditURL('../vercel.json',import.meta.url),'utf8'),
    readFile(auditURL('../lib/soop-gateway-api.js',import.meta.url),'utf8')
  ]);
  assert.match(login,/reason:'moved_to_local_agent'/);
  assert.doesNotMatch(login,/loadWallpaperState\(payload\.wid/);
  assert.match(admin,/operation==='wallpaper-control'/);
  const agentControl=await readFile(auditURL('../lib/agent-wallpaper-control.js',import.meta.url),'utf8');
  assert.match(agentControl,/select_wallpaper_sessions_v1/);
  assert.match(agentControl,/save_wallpaper_overlay_layout_v4/);
  assert.match(agentControl,/save_wallpaper_visible_keys_v1/);
  assert.match(agentControl,/save_wallpaper_merge_rules_v1/);
  assert.match(agentControl,/save_wallpaper_size_rules_v1/);
  assert.match(agentControl,/clear_wallpaper_overlay_layout_v1/);
  assert.match(admin,/http:\/\/127\.0\.0\.1:43120\/overlay\/wallpaper/);
  assert.match(admin,/img-src[^`]*https:\/\/\*\.sooplive\.com/);
  assert.match(dashboard,/localWallpaperEditor/);
  assert.match(dashboard,/wallpaperSessionDesiredIds/);
  assert.match(dashboard,/wallpaperSessionMutationVersion/);
  assert.match(dashboard,/while\(state\.wallpaperSessionAppliedVersion<state\.wallpaperSessionMutationVersion\)/);
  assert.match(dashboard,/wallpaperSettingsBusy\(\)/);
  assert.match(dashboard,/inert aria-disabled="true"/);
  assert.match(dashboard,/localBridgeRequest/);
  assert.match(admin,/wallpaper_editor_agent_only/);
  assert.match(login,/agent-wallpaper-control/);
  assert.match(routes,/"source": "\/api\/agent\/wallpaper-control"/);
  assert.match(routes,/"destination": "\/api\/login\?operation=agent-wallpaper-control"/);
  assert.match(dashboard,/beginWallpaperPointer/);
  assert.match(dashboard,/groupNode\.style\.pointerEvents='none'/);
  assert.match(dashboard,/wrap\.style\.pointerEvents='auto'/);
  assert.match(dashboard,/function wallpaperMetaHitAtPoint\(clientX,clientY\)/);
  assert.match(dashboard,/querySelectorAll\('#wallpaperPreview \.wallpaper-tile-meta'\)/);
  assert.match(dashboard,/clientX>=rect\.left&&clientX<=rect\.right&&clientY>=rect\.top&&clientY<=rect\.bottom/);
  assert.match(dashboard,/function wallpaperVisualImageHitAtPoint\(clientX,clientY\)/);
  assert.match(dashboard,/function wallpaperImageMaskScore\(image,record,clientX,clientY\)/);
  assert.match(dashboard,/function scheduleWallpaperOverlapMasks\(\)/);
  assert.match(dashboard,/request\('wallpaper-image-mask',\{method:'POST'/);
  assert.match(dashboard,/body:JSON\.stringify\(\{url:source\}\)/);
  assert.match(admin,/operation==='wallpaper-image-mask'/);
  assert.match(dashboard,/localCoverage\*\.72\+record\.density\*\.28/);
  assert.match(dashboard,/function beginWallpaperCardPointer\(event,fallbackGroup,fallbackNode\)/);
  assert.match(dashboard,/targetGroup\|\|fallbackGroup/);
  assert.match(dashboard,/wrap\.onpointerdown=state\.wallpaperEditing\?event=>beginWallpaperCardPointer\(event,group,groupNode\):null/);
  assert.match(dashboard,/groupNode\.onpointerdown=null/);
  assert.match(dashboard,/next\.onpointerdown=event=>beginWallpaperPointer\(event,group,'move',groupNode,null,'next'\)/);
  assert.match(dashboard,/next\.style\.pointerEvents='auto'/);
  assert.match(dashboard,/handle\.style\.pointerEvents='auto'/);
  assert.match(dashboard,/handle\.onpointerdown=event=>beginWallpaperPointer\(event,group,'resize',node,direction\)/);
  assert.doesNotMatch(dashboard,/groupNode\.style\.pointerEvents=selected/);
  assert.doesNotMatch(dashboard,/state\.wallpaperSelectedGroup=state\.wallpaperDraft\[0\]/);
  assert.match(dashboard,/fitWallpaperDraftGroup/);
  assert.match(dashboard,/function layoutWallpaperDraftGroup\(group,\{cardWidth,rows,slotColumns\}\)/);
  assert.match(dashboard,/const lane=Math\.floor\(index\/safeRows\),row=index%safeRows/);
  assert.doesNotMatch(dashboard,/amountRunCounts|columnCursor|for\(const run of merged\?runs/);
  assert.match(dashboard,/wallpaper-next-column/);
  assert.match(dashboard,/beginWallpaperPointer\(event,group,'move',groupNode,null,'next'\)/);
  assert.match(dashboard,/Math\.hypot\(screenDx,screenDy\)<=3/);
  assert.match(dashboard,/group\.nextSide=group\.nextSide==='left'\?'right':'left'/);
  assert.match(dashboard,/scheduleWallpaperAutoSave/);
  assert.match(dashboard,/flushWallpaperAutoSave/);
  assert.match(admin,/const WALLPAPER_LAYOUT_SAVE_PROTOCOL=3/);
  assert.match(admin,/status\(410\)\.json\(\{message:'풍벽지 배치는 별록 풍벽지 프로그램에서만 편집할 수 있습니다\.',code:'wallpaper_editor_agent_only'\}\)/);
  assert.match(dashboard,/WALLPAPER_LAYOUT_SAVE_PROTOCOL=3/);
  assert.match(dashboard,/layoutSaveProtocol:WALLPAPER_LAYOUT_SAVE_PROTOCOL/);
  assert.doesNotMatch(dashboard,/WALLPAPER_SAVE_MAX_CONFLICT_RETRIES|wallpaperSaveConflictCount/);
  assert.doesNotMatch(dashboard,/Math\.min\(500\*2\*\*/);
  assert.match(dashboard,/function moveWallpaperPointer[\s\S]*state\.wallpaperSavePending=true[\s\S]*function endWallpaperPointer/);
  assert.doesNotMatch(dashboard,/function moveWallpaperPointer[^\n]*scheduleWallpaperAutoSave/);
  assert.match(dashboard,/function endWallpaperPointer[^\n]*scheduleWallpaperAutoSave\(0\)/);
  assert.match(dashboard,/if\(state\.wallpaperPointer\)return false/);
  assert.match(dashboard,/자동 재시도하지 않습니다/);
  assert.match(dashboard,/layoutKey===state\.wallpaperLastSavedLayoutKey/);
  assert.doesNotMatch(dashboard,/scheduleWallpaperAutoSave\(0,false\)/);
  assert.match(dashboard,/initializeWallpaperEditor/);
  assert.match(dashboard,/변경 사항은 오버레이에 자동 반영됩니다/);
  assert.match(dashboard,/card\.displayKind==='challenge_success'/);
  assert.match(dashboard,/도전미션.*개 성공!/);
  assert.match(dashboard,/합병·크기 관리/);
  assert.match(dashboard,/wallpaperSizeRuleList/);
  assert.match(dashboard,/addWallpaperSizeRuleBtn/);
  assert.match(dashboard,/saveWallpaperSizeRulesBtn/);
  assert.match(dashboard,/save-size-rules/);
  assert.match(dashboard,/1~99 \/ 100~999 \/ 1,000~9,999/);
  assert.doesNotMatch(dashboard,/applyWallpaperSmallAmountWidth/);
  assert.match(dashboard,/wallpaperCatalog/);
  assert.doesNotMatch(dashboard,/wallpaper-group-close|한 번 더 ×/);
  assert.match(dashboard,/visibleKeys/);
  assert.doesNotMatch(dashboard,/wallpaperHideBelow|wallpaperHiddenAmounts|wallpaperHiddenList|saveWallpaperVisibilityBtn/);
  assert.match(dashboard,/wallpaperMergeList/);
  assert.match(dashboard,/installWallpaperResizeHandles/);
  assert.match(dashboard,/\['n','ne','e','se','s','sw','w','nw'\]|Object\.keys\(labels\)/);
  assert.match(dashboard,/function wallpaperResizeMode\(group\)/);
  assert.match(dashboard,/영역 조절/);
  assert.match(dashboard,/카드 크기/);
  assert.match(dashboard,/resizeMode:wallpaperResizeMode\(group\)/);
  assert.match(dashboard,/pointer\.resizeMode==='area'/);
  assert.match(dashboard,/layoutWallpaperDraftGroup\(candidate,\{cardWidth,rows,slotColumns:slots\}\)/);
  assert.match(dashboard,/editorResizeMode:saved\.editorResizeMode/);
  assert.match(dashboard,/\.wallpaper-editor-canvas\{width:1920px;height:1080px\}/);
  assert.match(dashboard,/font:800 var\(--label-size,14px\)\/1\.05 Pretendard,"Noto Sans KR",system-ui,sans-serif/);
  assert.match(dashboard,/function wallpaperEditorCanvas\(preview\)/);
  assert.match(dashboard,/canvas\.style\.transform='scale\('/);
  assert.match(dashboard,/node\.style\.left=Number\(group\.x\)\+'px'/);
  assert.match(dashboard,/node\.style\.left=Number\(card\.x\)\+'px'/);
  assert.match(dashboard,/container-type:size/);
  assert.match(dashboard,/node\.style\.zIndex=String\(Math\.max\(1,Number\(card\.zIndex\)\|\|1\)\)/);
  assert.match(dashboard,/image\.style\.zIndex='1'/);
  assert.match(dashboard,/meta\.style\.zIndex='1000'/);
  assert.match(dashboard,/image\.style\.filter='none'/);
  assert.match(dashboard,/meta\.style\.filter='none'/);
  assert.match(dashboard,/wallpaper-meta-name/);
  assert.match(dashboard,/info:'별풍선 '\+amount\+'개'/);
  assert.match(dashboard,/compact:actor\+' '\+amount\+'개'/);
  assert.match(dashboard,/compact:actor\+' '\+amount\+'개월'/);
  assert.doesNotMatch(dashboard,/compact:[^;}]*·/);
  assert.match(dashboard,/width<150\|\|height<160/);
  assert.match(dashboard,/\.wallpaper-tile\.text-only \.wallpaper-tile-meta\{font-size:clamp\(10px,min\(8cqw,42cqh\),24px\)\}/);
  assert.match(dashboard,/letter-spacing:-\.01em/);
  assert.match(dashboard,/높이 .*rowsPerColumn/);
  assert.match(dashboard,/wallpaper-overlay-boundary/);
  assert.match(dashboard,/canvas\.querySelector\('\.wallpaper-overlay-boundary'\)\?\.remove\(\)/);
  assert.match(dashboard,/from '\.\/wallpaper-layout\.js'/);
  assert.match(dashboard,/WALLPAPER_EDITOR_MARGIN_X=\$\{WALLPAPER_EDITOR_MARGIN_X\}/);
  assert.match(dashboard,/wallpaperStateMatchesLayout/);
  assert.match(dashboard,/서버가 저장한 배치를 다시 확인하지 못했습니다/);
  assert.match(dashboard,/WALLPAPER_SNAP_SCREEN_PX=7/);
  assert.match(dashboard,/WALLPAPER_GROUP_SNAP_SCREEN_PX=7/);
  assert.match(dashboard,/WALLPAPER_GROUP_CROSS_SNAP_SCREEN_PX=18/);
  assert.match(dashboard,/WALLPAPER_VERTICAL_NEIGHBOR_SCREEN_PX=96/);
  assert.match(dashboard,/WALLPAPER_VERTICAL_LOCK_RELEASE_SCREEN_PX=28/);
  assert.match(dashboard,/WALLPAPER_META_HEIGHT_RATIO=\.2035/);
  assert.match(dashboard,/function wallpaperDonationBoxBounds\(group\)/);
  assert.match(dashboard,/function wallpaperOpaqueMaskBounds\(alpha,maskWidth,maskHeight\)/);
  assert.match(dashboard,/opaqueBounds:wallpaperOpaqueMaskBounds\(alpha,maskWidth,maskHeight\)/);
  assert.match(dashboard,/function wallpaperVisibleImageBounds\(group\)/);
  assert.match(dashboard,/wallpaperImageSourcesByAssetKey=new Map\(\)/);
  assert.match(dashboard,/function rememberWallpaperImageSource\(assetKey,image\)/);
  assert.match(dashboard,/imageBoxHeight=height\*\(1-WALLPAPER_META_HEIGHT_RATIO\)/);
  assert.match(dashboard,/hasImage=Boolean\(card\.imageUrl\|\|group\.imageUrl\)/);
  assert.match(dashboard,/height\*\(1-WALLPAPER_META_HEIGHT_RATIO\)/);
  assert.match(dashboard,/moving=wallpaperDonationBoxBounds\(candidate\)/);
  assert.match(dashboard,/bounds=wallpaperDonationBoxBounds\(other\)/);
  assert.doesNotMatch(dashboard,/function wallpaperVisibleCardBounds/);
  assert.match(dashboard,/snapWallpaperMove\(candidate,scale,movingId,pointer=state\.wallpaperPointer\)/);
  assert.match(dashboard,/other\.id===movingId/);
  assert.match(dashboard,/intervalGap\(moving\.top,moving\.bottom,top,bottom\)<=neighborThreshold/);
  assert.match(dashboard,/nearOverlaps\(moving\.left,moving\.right,left,right\)/);
  assert.match(dashboard,/options\.filter\(option=>option\.distance<=option\.threshold\)/);
  assert.match(dashboard,/function bringWallpaperGroupToFront\(groupId\)/);
  assert.match(dashboard,/wallpaper-bring-front/);
  assert.match(dashboard,/function renderWallpaperSnapGuide\(pointer=state\.wallpaperPointer\)/);
  assert.match(dashboard,/wallpaper-snap-guide/);
  assert.match(dashboard,/wallpaper-image-top-snap-guide/);
  assert.match(dashboard,/kind:'image-top',targetY:otherImage\.top/);
  assert.match(dashboard,/이미지의 실제 최상단에 맞췄습니다/);
  assert.match(dashboard,/layer:Number\(group\.layer\)\|\|index\+1/);
  assert.match(dashboard,/preview\.onpointerdown=deselectWallpaperGroup/);
  assert.match(dashboard,/function updateWallpaperImage/);
  assert.match(dashboard,/image\.dataset\.assetKey!==assetKey/);
  assert.match(dashboard,/state\.wallpaperSelectedGroup=null;renderWallpaper\(\)/);
  assert.match(dashboard,/\.wallpaper-preview\{isolation:isolate;background:/);
  assert.match(dashboard,/\.accountModal\{z-index:50000\}/);
  assert.match(agentControl,/values\[0\]<-WALLPAPER_EDITOR_MARGIN_X\|\|values\[1\]<-WALLPAPER_EDITOR_MARGIN_Y/);
  assert.match(dashboard,/session\.isLive/);
  assert.match(dashboard,/group\.direction=group\.nextSide==='left'\?'rtl':'ltr'/);
  assert.match(dashboard,/wallpaperTimer=setInterval\(refreshWallpaperLive,1500\)/);
  assert.match(dashboard,/save-layout/);
  assert.match(routes,/\/api\/auth\/soop\/wallpaper\/state[\s\S]*\/overlay\/soop-wallpaper[\s\S]*\/dashboard\/wallpaper/);
  assert.match(gateway,/ingest_native_overlay_soop_donation_v8/);
});

test('wallpaper layout v3 cuts off legacy retry storms and treats identical saves as idempotent',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260901162843_stop_legacy_wallpaper_layout_retry_storm.sql',import.meta.url),'utf8');
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v3/i);
  assert.match(sql,/p_protocol<>2/i);
  assert.match(sql,/v_same_count=v_tile_count[\s\S]*return v_revision/i);
  assert.match(sql,/is distinct from[\s\S]*tile\.next_side/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v2[\s\S]*wallpaper editor upgrade required/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_overlay_layout_v3[\s\S]*grant execute[\s\S]*service_role/i);
});

test('wallpaper layout v4 persists bounded stacking order for web and Agent overlays',async()=>{
  const [sql,service,edgeMapper]=await Promise.all([
    readFile(auditURL('../supabase/migrations/20260903133204_wallpaper_layer_order.sql',import.meta.url),'utf8'),
    readFile(auditURL('../lib/wallpaper-service.js',import.meta.url),'utf8'),
    readFile(auditURL('../supabase/functions/_shared/agent-wallpaper.ts',import.meta.url),'utf8')
  ]);
  assert.match(sql,/add column if not exists layout_layer integer/i);
  assert.match(sql,/create or replace function public\.save_wallpaper_overlay_layout_v4/i);
  assert.match(sql,/p_protocol<>3/i);
  assert.match(sql,/tile\.layer not between 1 and 216/i);
  assert.match(sql,/layout_layer=tile\.layer/i);
  assert.match(sql,/'layoutLayer', tile\.layout_layer/i);
  assert.match(sql,/revoke all on function public\.save_wallpaper_overlay_layout_v4[\s\S]*grant execute[\s\S]*service_role/i);
  assert.match(service,/layout_next_side,layout_layer/);
  assert.match(service,/layer:Number\.isSafeInteger\(Number\(row\.layout_layer\)\)/);
  assert.match(edgeMapper,/layer: integer\(row\.layoutLayer/);
});

test('wallpaper stabilization accepts stale layout revisions without retries and restores backup boundaries',async()=>{
  const [sql,leaseFix]=await Promise.all([
    readFile(auditURL('../supabase/migrations/20260903203353_stabilize_wallpaper_and_security_boundaries.sql',import.meta.url),'utf8'),
    readFile(auditURL('../supabase/migrations/20260904214500_fix_backup_lease_column_ambiguity.sql',import.meta.url),'utf8')
  ]);
  assert.match(sql,/save_wallpaper_overlay_layout_v3[\s\S]*save_wallpaper_overlay_layout_v4/i);
  assert.match(sql,/if p_expected_revision>v_revision/i);
  assert.match(sql,/wallpaper layout revision is ahead of the server/);
  assert.match(sql,/create table if not exists public\.byeollog_workspace_backup_leases/i);
  assert.match(sql,/create table if not exists public\.byeollog_account_withdrawal_intents/i);
  assert.match(sql,/create or replace function public\.begin_workspace_backup_v1/i);
  assert.match(sql,/create or replace function public\.release_workspace_backup_lease_v1/i);
  assert.match(sql,/create or replace function public\.prepare_account_withdrawal_v1/i);
  assert.match(sql,/create or replace function public\.confirm_account_withdrawal_storage_v1/i);
  assert.match(sql,/confirmed withdrawal intent is required/i);
  assert.match(sql,/create index if not exists byeollog_soop_core_roulette_results_donation_id_idx/i);
  assert.match(sql,/cron\.unschedule/i);
  assert.match(leaseFix,/from public\.byeollog_workspace_backup_leases(?:\s+as)?\s+lease/i);
  assert.match(leaseFix,/lease\.expires_at/i);
  assert.match(leaseFix,/grant execute on function public\.begin_workspace_backup_v1[\s\S]*service_role/i);
});
