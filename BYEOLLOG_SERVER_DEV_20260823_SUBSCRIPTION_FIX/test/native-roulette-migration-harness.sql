\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema byeollog_automation;

create table public.byeollog_workspaces(
  id uuid primary key,
  display_name text not null,
  slug text not null,
  status text not null
);
create table public.byeollog_workspace_members(
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  primary key(workspace_id,user_id)
);
create table byeollog_automation.agent_devices(
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  device_id uuid not null,
  device_name text not null,
  registered_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  primary key(workspace_id,device_id)
);
create or replace function byeollog_automation.assert_runtime_locked_v1(
  uuid,uuid,uuid,text,text,text)
returns void language sql set search_path='' as $$select$$;
create or replace function byeollog_automation.assert_agent_device_locked_v1(
  uuid,uuid,text)
returns void language sql set search_path='' as $$select$$;

\ir ../supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql

insert into public.byeollog_workspaces(id,display_name,slug,status)
values('10000000-0000-4000-8000-000000000001','테스트','test','active');
insert into public.byeollog_workspace_members(workspace_id,user_id,role)
values('10000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','owner');
insert into byeollog_automation.agent_devices(workspace_id,device_id,device_name)
values('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','방송 PC');

set role service_role;
select public.save_native_roulette_draft_v1(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'name','방송 룰렛','balloonsPerSpin',30,'allowMultipleSpins',true,
    'agentDeviceId','20000000-0000-4000-8000-000000000001',
    'overlayAssetKey','roulette_navy_gold_v1',
    'overlayAssetSha256','8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',
    'overlayAssetBytes',25698598,'soundKey','roulette_spin_v1',
    'soundVolumePercent',75,'ttsVolumePercent',85,'followupChatTtsWindowSeconds',10,
    'items',jsonb_build_array(
      jsonb_build_object(
        'resultText','A 단컷 & 움짤','probabilityPpm',250000,'directUpbo',true,
        'upboEventName','8월 이벤트','outputTypes',jsonb_build_array('A 단컷','A 움짤'),
        'ttsText',null,'ttsVoiceKey',null),
      jsonb_build_object(
        'resultText','간식 당첨','probabilityPpm',750000,'directUpbo',false,
        'upboEventName',null,'outputTypes','[]'::jsonb,'ttsText','간식 당첨!',
        'ttsVoiceKey','c17443d2ca5553987054f2f24c9d04d55b19c4551cb99cc2a1880a565602428e')
    )
  )
);
reset role;

do $assert$
declare v_settings jsonb;v_revision_id uuid;v_overlay uuid;v_tts uuid;
begin
  if (select count(*) from byeollog_automation.native_roulette_assets)<>7 then
    raise exception 'native roulette asset catalog mismatch';
  end if;
  if (select count(*) from byeollog_automation.native_roulette_items)<>2 then
    raise exception 'native roulette item save mismatch';
  end if;
  if (select count(*) from byeollog_automation.native_roulette_cache_requirements)<>2 then
    raise exception 'direct upbo unexpectedly created a TTS cache requirement';
  end if;
  if exists(select 1 from byeollog_automation.native_roulette_cache_requirements requirement
    join byeollog_automation.native_roulette_items item on item.id=requirement.item_id
    where item.direct_upbo) then
    raise exception 'direct upbo TTS cache requirement leaked';
  end if;
  v_settings:=public.get_native_roulette_settings_v1(
    '10000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001');
  if v_settings#>>'{profile,status}'<>'cache_pending'
     or (v_settings#>>'{profile,cache,pending}')::integer<>2
     or (v_settings#>>'{profile,followupChatTtsWindowSeconds}')::integer<>10
     or (v_settings->>'activationAvailable')::boolean then
    raise exception 'native roulette draft safety state mismatch';
  end if;
  if to_regprocedure('public.activate_native_roulette_v1(uuid,uuid)') is not null then
    raise exception 'native roulette activation RPC must not exist';
  end if;
  begin
    perform public.ingest_native_roulette_soop_donation_v1(
      '10000000-0000-4000-8000-000000000001','event-1','viewer','시청자',30,null,clock_timestamp());
    raise exception 'inactive native roulette accepted a donation';
  exception when sqlstate '55000' then null; end;

  select revision.id into strict v_revision_id
  from byeollog_automation.native_roulette_revisions revision;
  select requirement.id into strict v_overlay
  from byeollog_automation.native_roulette_cache_requirements requirement
  where requirement.resource_kind='overlay_webp';
  select requirement.id into strict v_tts
  from byeollog_automation.native_roulette_cache_requirements requirement
  where requirement.resource_kind='result_tts';
  perform public.g3a_ack_native_roulette_cache_v1(
    '10000000-0000-4000-8000-000000000001',v_overlay,
    '8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',25698598,null,
    '20000000-0000-4000-8000-000000000001','hash',
    '11000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime','db');
  perform public.g3a_ack_native_roulette_cache_v1(
    '10000000-0000-4000-8000-000000000001',v_tts,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1000,
    'raffle-winner-cosyvoice3-v1','20000000-0000-4000-8000-000000000001','hash',
    '11000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime','db');
  if (select status from byeollog_automation.native_roulette_revisions where id=v_revision_id)<>'ready' then
    raise exception 'native roulette revision did not become cache ready';
  end if;
  if (select active_revision_id from byeollog_automation.native_roulette_profiles limit 1) is not null then
    raise exception 'cache readiness activated native roulette';
  end if;
end
$assert$;

-- Harness-only activation and deterministic selection. The dormant migration itself
-- intentionally exposes no activation RPC.
update byeollog_automation.native_roulette_revisions
set status='active',activated_at=clock_timestamp()
where status='ready';
update byeollog_automation.native_roulette_profiles profile
set active_revision_id=profile.latest_revision_id;
create or replace function byeollog_automation.native_roulette_sample_ppm_v1()
returns integer language sql volatile set search_path='' as $$select 500000$$;
revoke all on function byeollog_automation.native_roulette_sample_ppm_v1()
  from public,anon,authenticated,service_role;

set role service_role;
select public.ingest_native_roulette_soop_donation_v1(
  '10000000-0000-4000-8000-000000000001','event-followup','viewer_example','테스트 시청자',
  30,null,clock_timestamp()-interval '9.85 seconds');
reset role;
select public.ingest_native_roulette_soop_chat_v1(
  '10000000-0000-4000-8000-000000000001','chat-followup','viewer_example','테스트 시청자',
  '딸깍',(select occurred_at+interval '9.85 seconds'
    from byeollog_automation.native_roulette_donations where soop_event_id='event-followup'));

do $followup$
declare v_result record;v_chat record;
begin
  if (select status from byeollog_automation.native_roulette_chat_followups
      where captured_chat_event_id='chat-followup')<>'captured' then
    raise exception 'native roulette follow-up chat was not captured';
  end if;
  if (select elapsed_seconds from byeollog_automation.native_roulette_chat_followups
      where captured_chat_event_id='chat-followup')<>10 then
    raise exception 'native roulette follow-up chat rounding mismatch';
  end if;
  select * into strict v_result from public.claim_native_roulette_dispatch_v1(
    '10000000-0000-4000-8000-000000000001','harness-worker',10,45);
  if v_result.dispatch_kind<>'automation_event' then
    raise exception 'donation chat escaped ahead of roulette result';
  end if;
  perform public.finish_native_roulette_dispatch_v1(
    '10000000-0000-4000-8000-000000000001',v_result.dispatch_id,
    'harness-worker',true,false,null);
  select * into strict v_chat from public.claim_native_roulette_dispatch_v1(
    '10000000-0000-4000-8000-000000000001','harness-worker',10,45);
  if v_chat.dispatch_kind<>'donation_chat_tts'
     or v_chat.payload->>'displayText'<>'[10초전] 테스트 시청자 : 딸깍'
     or v_chat.payload->>'ttsText'<>'딸깍'
  then raise exception 'native roulette follow-up chat dispatch mismatch'; end if;
  perform public.finish_native_roulette_dispatch_v1(
    '10000000-0000-4000-8000-000000000001',v_chat.dispatch_id,
    'harness-worker',true,false,null);
  if (public.ingest_native_roulette_soop_chat_v1(
      '10000000-0000-4000-8000-000000000001','chat-followup','viewer_example','테스트 시청자',
      '딸깍',(select occurred_at+interval '9.85 seconds'
        from byeollog_automation.native_roulette_donations where soop_event_id='event-followup'))
      ->>'duplicate')::boolean is not true
  then raise exception 'native roulette follow-up chat duplicate was not suppressed'; end if;
end
$followup$;

delete from public.byeollog_workspaces
where id='10000000-0000-4000-8000-000000000001';
do $cleanup$
begin
  if exists(select 1 from byeollog_automation.native_roulette_profiles)
     or exists(select 1 from byeollog_automation.native_roulette_revisions)
     or exists(select 1 from byeollog_automation.native_roulette_items)
     or exists(select 1 from byeollog_automation.native_roulette_cache_requirements)
     or exists(select 1 from byeollog_automation.native_roulette_chat_followups)
     or exists(select 1 from byeollog_automation.native_roulette_dispatch_outbox)
  then raise exception 'native roulette workspace cascade cleanup failed'; end if;
end
$cleanup$;

select 'NATIVE_ROULETTE_MIGRATION_PASS' as result;
