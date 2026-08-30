-- Keep the approved-SOOP integration in a broadcast-only, pre-approval lane.
-- Native roulette may draw and render in the common OBS overlay, but it must
-- not mutate the legacy upbo/statistics tables until a later explicit migration
-- removes this guard after product approval.

create table if not exists byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1 (
  source_task_id uuid primary key,
  workspace_id uuid not null,
  task_snapshot jsonb not null check (jsonb_typeof(task_snapshot)='object'),
  isolated_at timestamptz not null default clock_timestamp()
);

alter table byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1
  enable row level security;
revoke all on table byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1
  from public,anon,authenticated,service_role;
grant select on table byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1
  to service_role;

insert into byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1(
  source_task_id,workspace_id,task_snapshot)
select task.id,task.workspace_id,to_jsonb(task)
from public.bangsel_tasks task
where task.source='byeollog_native_roulette'
   or coalesce(task.source_event_key,'') like 'soop-native:%'
on conflict(source_task_id) do nothing;

delete from public.bangsel_tasks task
where task.id in (
  select quarantined.source_task_id
  from byeollog_automation.preapproval_native_roulette_upbo_quarantine_v1 quarantined
);

create or replace function byeollog_automation.deny_preapproval_native_roulette_upbo_v1()
returns trigger
language plpgsql
set search_path=''
as $function$
begin
  if new.source='byeollog_native_roulette'
     or coalesce(new.source_event_key,'') like 'soop-native:%'
  then
    raise exception 'native roulette upbo writes are isolated until approval'
      using errcode='55000';
  end if;
  return new;
end
$function$;
revoke all on function byeollog_automation.deny_preapproval_native_roulette_upbo_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists deny_preapproval_native_roulette_upbo_v1 on public.bangsel_tasks;
create trigger deny_preapproval_native_roulette_upbo_v1
before insert or update of source,source_event_key on public.bangsel_tasks
for each row execute function byeollog_automation.deny_preapproval_native_roulette_upbo_v1();

create or replace function public.ingest_native_roulette_soop_donation_v2(
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
  v_sample integer;v_item jsonb;v_spin_id uuid;v_direct boolean;v_regular_count integer:=0;
  v_message text;v_window integer;v_buffer byeollog_automation.native_roulette_chat_buffer_v2%rowtype;
  v_image jsonb;v_asset_key text;v_command jsonb;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 200
     or p_event_id~'[[:cntrl:]]' or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]' or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]' or p_amount not between 1 and 1000000000000
     or p_occurred_at is null or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or (p_message is not null and (char_length(p_message)>1000 or p_message~'[[:cntrl:]]'))
  then raise exception 'native roulette SOOP donation is invalid' using errcode='22023'; end if;

  select * into v_service from public.byeollog_native_roulette_services
    where workspace_id=p_workspace_id and state='active';
  if not found then raise exception 'native roulette is not active' using errcode='55000'; end if;
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
    occurred_at,trigger_kind,spin_count,status)
  values(p_workspace_id,v_service.service_revision,btrim(p_event_id),lower(btrim(p_actor_id)),
    btrim(p_actor_name),p_amount,nullif(btrim(p_message),''),p_occurred_at,
    v_trigger_kind,v_spin_count,case when v_spin_count=0 then 'ignored' else 'queued' end)
  on conflict(workspace_id,provider_event_id) do nothing returning * into v_event;
  if not found then
    select * into strict v_existing from byeollog_automation.native_roulette_events_v2
      where workspace_id=p_workspace_id and provider_event_id=btrim(p_event_id);
    if v_existing.actor_id<>lower(btrim(p_actor_id)) or v_existing.amount<>p_amount
       or v_existing.occurred_at<>p_occurred_at
    then raise exception 'native roulette SOOP event identity changed' using errcode='40001'; end if;
    return jsonb_build_object('duplicate',true,'eventId',v_existing.id,
      'spinCount',v_existing.spin_count,'status',v_existing.status,
      'dataIsolation','pre_approval','upboWrites',0);
  end if;
  if v_spin_count=0 then
    return jsonb_build_object('duplicate',false,'eventId',v_event.id,'spinCount',0,
      'status','ignored','dataIsolation','pre_approval','upboWrites',0);
  end if;

  v_asset_key:=v_snapshot->>'overlayAssetKey';
  for v_spin_index in 0..v_spin_count-1 loop
    v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
    select item into strict v_item from (
      select item,sum((item->>'probabilityPpm')::integer) over(order by ordinality) upper_bound
      from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality)
    ) chosen where v_sample<chosen.upper_bound order by chosen.upper_bound limit 1;
    v_direct:=(v_item->>'directUpbo')::boolean;
    insert into byeollog_automation.native_roulette_spins_v2(
      event_id,workspace_id,spin_index,sample_ppm,result_text,direct_upbo,item_snapshot)
    values(v_event.id,p_workspace_id,v_spin_index,v_sample,v_item->>'resultText',v_direct,v_item)
    returning id into v_spin_id;

    -- Even an item marked as upbo is presentation-only before approval.  The
    -- intent remains in the isolated spin snapshot, but no legacy task/fan row
    -- is written and the result is still visible in OBS for validation.
    v_regular_count:=v_regular_count+1;
    v_command:=jsonb_build_object(
      'schemaVersion',3,'kind','roulette_spin','commandId',v_spin_id,
      'rouletteName',v_snapshot->>'name','triggerKind',v_trigger_kind,
      'spinIndex',v_spin_index,'spinCount',v_spin_count,
      'actor',jsonb_build_object('name',btrim(p_actor_name)),
      'amount',p_amount,'resultText',v_item->>'resultText',
      'ttsText',coalesce(nullif(v_item->>'ttsText',''),(v_item->>'resultText')||', 당첨!'),
      'ttsVolumePercent',v_service.tts_volume_percent,
      'soundVolumePercent',v_service.sound_volume_percent,
      'overlayAssetKey',v_asset_key,'customImage',v_image,
      'dataIsolation','pre_approval','upboRequested',v_direct,'upboSuppressed',v_direct);
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,spin_id,command_kind,payload)
    values(p_workspace_id,v_event.id,v_spin_id,'roulette_spin',v_command);
  end loop;

  v_message:=nullif(left(btrim(p_message),300),'');
  v_window:=(v_snapshot->>'followupChatTtsWindowSeconds')::integer;
  if v_message is not null then
    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
  elsif v_window>0 then
    select * into v_buffer from byeollog_automation.native_roulette_chat_buffer_v2
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and consumed_event_id is null and occurred_at between p_occurred_at
        and p_occurred_at+pg_catalog.make_interval(secs=>v_window)
    order by occurred_at,received_at limit 1 for update;
    if found then
      update byeollog_automation.native_roulette_chat_buffer_v2
        set consumed_event_id=v_event.id
        where workspace_id=p_workspace_id and provider_chat_id=v_buffer.provider_chat_id;
      perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
        v_event,v_buffer.message,v_buffer.provider_chat_id,
        round(extract(epoch from(v_buffer.occurred_at-p_occurred_at)))::integer,
        'followup_chat',v_service.tts_volume_percent);
    else
      insert into byeollog_automation.native_roulette_chat_waits_v2(
        event_id,workspace_id,actor_id,opens_at,expires_at)
      values(v_event.id,p_workspace_id,lower(btrim(p_actor_id)),p_occurred_at,
        p_occurred_at+pg_catalog.make_interval(secs=>v_window));
    end if;
  end if;

  update byeollog_automation.native_roulette_events_v2 set status='queued'
    where id=v_event.id;
  return jsonb_build_object('duplicate',false,'eventId',v_event.id,
    'spinCount',v_spin_count,'presentationCount',v_regular_count,'status','queued',
    'dataIsolation','pre_approval','upboWrites',0);
end
$function$;

revoke all on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

comment on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) is
  'Pre-approval broadcast-only native roulette ingest. Writes only isolated roulette/outbox tables; legacy upbo and statistics writes are forbidden.';
