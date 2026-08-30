-- Streamer-triggered donation checks use the same active roulette snapshot,
-- cryptographic sampler and durable OBS outbox as SOOP donations.  Test rows
-- are permanently labelled so they can never be included in real statistics
-- or legacy upbo processing.

alter table byeollog_automation.native_roulette_events_v2
  add column if not exists is_test boolean not null default false;
alter table byeollog_automation.native_roulette_spins_v2
  add column if not exists is_test boolean not null default false;
alter table byeollog_automation.native_roulette_overlay_outbox_v2
  add column if not exists is_test boolean not null default false;

comment on column byeollog_automation.native_roulette_events_v2.is_test is
  'True only for authenticated streamer overlay checks. Exclude from every real donation statistic.';
comment on column byeollog_automation.native_roulette_spins_v2.is_test is
  'Inherited from the donation test event. Never creates upbo or action side effects.';
comment on column byeollog_automation.native_roulette_overlay_outbox_v2.is_test is
  'Presentation-only command created by the streamer donation test control.';

create index if not exists native_roulette_events_v2_test_retention_idx
  on byeollog_automation.native_roulette_events_v2(workspace_id,received_at desc)
  where is_test;

create or replace function public.enqueue_native_overlay_donation_test_v1(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_service public.byeollog_native_roulette_services%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_existing byeollog_automation.native_roulette_events_v2%rowtype;
  v_snapshot jsonb;v_trigger_kind text;v_spin_count integer:=0;v_spin_index integer;
  v_sample integer;v_item jsonb;v_spin_id uuid;v_direct boolean;v_command jsonb;
  v_image jsonb;v_asset_key text;v_signature jsonb;v_ceremony jsonb;
  v_message text;v_recent_count integer:=0;v_presentation_count integer:=0;
begin
  if p_workspace_id is null
     or p_event_id!~'^overlay-test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor_id<>'byeollog-overlay-test'
     or p_actor_name<>'후원 테스트'
     or p_amount not between 1 and 1000000
     or p_occurred_at is null
     or p_occurred_at not between clock_timestamp()-interval '1 minute' and clock_timestamp()+interval '10 seconds'
     or (p_message is not null and (char_length(p_message)>120 or p_message~'[[:cntrl:]]'))
  then raise exception 'overlay donation test input is invalid' using errcode='22023'; end if;

  select count(*) into v_recent_count
  from byeollog_automation.native_roulette_events_v2 event
  where event.workspace_id=p_workspace_id and event.is_test
    and event.received_at>clock_timestamp()-interval '1 minute';
  if v_recent_count>=12 then
    raise exception 'overlay donation test rate limit exceeded' using errcode='P0001';
  end if;

  select * into v_service
  from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id and service.state='active';
  if not found then
    raise exception 'native roulette is not active' using errcode='55000';
  end if;

  v_snapshot:=v_service.activation_snapshot;
  if p_amount=(v_snapshot->>'balloonsPerSpin')::bigint then
    v_trigger_kind:='single';v_spin_count:=1;
    v_image:=coalesce(v_snapshot->'customSingleImage','null'::jsonb);
  elsif (v_snapshot->>'seriesEnabled')::boolean
    and p_amount=(v_snapshot->>'seriesBalloons')::bigint then
    v_trigger_kind:='series';v_spin_count:=(v_snapshot->>'seriesSpinCount')::integer;
    v_image:=coalesce(v_snapshot->'customSeriesImage',v_snapshot->'customSingleImage','null'::jsonb);
  end if;

  insert into byeollog_automation.native_roulette_events_v2(
    workspace_id,service_revision,provider_event_id,actor_id,actor_name,amount,message,
    occurred_at,trigger_kind,spin_count,status,is_test)
  values(p_workspace_id,v_service.service_revision,btrim(p_event_id),p_actor_id,p_actor_name,
    p_amount,nullif(btrim(p_message),''),p_occurred_at,v_trigger_kind,v_spin_count,
    case when v_spin_count=0 then 'ignored' else 'queued' end,true)
  on conflict(workspace_id,provider_event_id) do nothing returning * into v_event;

  if not found then
    select * into strict v_existing
    from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.provider_event_id=btrim(p_event_id);
    return jsonb_build_object(
      'duplicate',true,'eventId',v_existing.id,'spinCount',v_existing.spin_count,
      'status',v_existing.status,'dataIsolation','manual_overlay_test','upboWrites',0);
  end if;

  if p_amount between 1 and 30000 then
    select balloon.pc_image into v_signature
    from public.byeollog_signature_balloons balloon
    where balloon.workspace_id=p_workspace_id and balloon.balloon_count=p_amount::integer;
  end if;
  v_ceremony:=case when v_signature is not null then jsonb_build_object(
    'source','signature','asset',v_signature,'providerUrl',null)
    else jsonb_build_object('source','none') end;

  v_asset_key:=v_snapshot->>'overlayAssetKey';
  if v_spin_count>0 then
    for v_spin_index in 0..v_spin_count-1 loop
      v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
      select item into strict v_item from (
        select item,sum((item->>'probabilityPpm')::integer)
          over(order by ordinality) upper_bound
        from jsonb_array_elements(v_snapshot->'items')
          with ordinality valueset(item,ordinality)
      ) chosen
      where v_sample<chosen.upper_bound
      order by chosen.upper_bound limit 1;
      v_direct:=(v_item->>'directUpbo')::boolean;

      insert into byeollog_automation.native_roulette_spins_v2(
        event_id,workspace_id,spin_index,sample_ppm,result_text,direct_upbo,item_snapshot,is_test)
      values(v_event.id,p_workspace_id,v_spin_index,v_sample,v_item->>'resultText',
        v_direct,v_item,true) returning id into v_spin_id;

      v_command:=jsonb_build_object(
        'schemaVersion',5,'kind','roulette_spin','commandId',v_spin_id,
        'rouletteName',v_snapshot->>'name','triggerKind',v_trigger_kind,
        'spinIndex',v_spin_index,'spinCount',v_spin_count,
        'actor',jsonb_build_object('name',p_actor_name),'amount',p_amount,
        'resultText',v_item->>'resultText',
        'ttsText',coalesce(nullif(v_item->>'ttsText',''),(v_item->>'resultText')||', 당첨!'),
        'ttsVolumePercent',v_service.tts_volume_percent,
        'soundVolumePercent',v_service.sound_volume_percent,
        'overlayAssetKey',v_asset_key,'customImage',v_image,'ceremony',v_ceremony,
        'testMode',true,'dataIsolation','manual_overlay_test',
        'upboRequested',v_direct,'upboSuppressed',v_direct);
      insert into byeollog_automation.native_roulette_overlay_outbox_v2(
        workspace_id,event_id,spin_id,command_kind,payload,expires_at,is_test)
      values(p_workspace_id,v_event.id,v_spin_id,'roulette_spin',v_command,
        clock_timestamp()+interval '2 minutes',true);
      v_presentation_count:=v_presentation_count+1;
    end loop;
  elsif v_signature is not null then
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,command_kind,payload,expires_at,is_test)
    values(p_workspace_id,v_event.id,'donation_ceremony',jsonb_build_object(
      'schemaVersion',5,'kind','donation_ceremony','donationEventId',btrim(p_event_id),
      'actor',jsonb_build_object('name',p_actor_name),'amount',p_amount,
      'ceremony',v_ceremony,'testMode',true,'dataIsolation','manual_overlay_test'),
      clock_timestamp()+interval '2 minutes',true);
    v_presentation_count:=1;
  end if;

  v_message:=nullif(btrim(p_message),'');
  if v_spin_count>0 and v_message is not null then
    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      set is_test=true,payload=outbox.payload||jsonb_build_object(
        'testMode',true,'dataIsolation','manual_overlay_test')
    where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event.id
      and outbox.command_kind='donation_chat_tts';
  end if;

  update byeollog_automation.native_roulette_events_v2 event
    set status=case when v_spin_count>0 then 'queued' else 'ignored' end
  where event.id=v_event.id;

  return jsonb_build_object(
    'duplicate',false,'eventId',v_event.id,'spinCount',v_spin_count,
    'presentationCount',v_presentation_count,
    'status',case when v_presentation_count>0 then 'queued' else 'ignored' end,
    'dataIsolation','manual_overlay_test','upboWrites',0,'statisticsWrites',0);
end
$function$;

revoke all on function public.enqueue_native_overlay_donation_test_v1(
  uuid,text,text,text,bigint,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_native_overlay_donation_test_v1(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

comment on function public.enqueue_native_overlay_donation_test_v1(
  uuid,text,text,text,bigint,text,timestamptz) is
  'Queues an authenticated streamer presentation check through the production roulette sampler and OBS outbox. Test rows are permanently isolated from donation statistics, actions and upbo.';

;
