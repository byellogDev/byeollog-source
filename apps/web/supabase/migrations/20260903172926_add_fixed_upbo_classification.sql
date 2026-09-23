create table if not exists public.byeollog_fixed_upbo_rules (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  balloons bigint not null check (balloons between 1 and 1000000000),
  event_name text not null,
  upbo_type text not null,
  quantity integer not null default 1 check (quantity between 1 and 1000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, balloons, event_name, upbo_type),
  constraint byeollog_fixed_upbo_event_name_check
    check (char_length(btrim(event_name)) between 1 and 120 and event_name !~ '[[:cntrl:]]'),
  constraint byeollog_fixed_upbo_type_check
    check (char_length(btrim(upbo_type)) between 1 and 120 and upbo_type !~ '[[:cntrl:]]')
);

create index if not exists byeollog_fixed_upbo_rules_workspace_amount_idx
  on public.byeollog_fixed_upbo_rules(workspace_id, balloons, updated_at desc);

alter table public.byeollog_fixed_upbo_rules enable row level security;
drop policy if exists byeollog_fixed_upbo_rules_deny_browser on public.byeollog_fixed_upbo_rules;
create policy byeollog_fixed_upbo_rules_deny_browser
  on public.byeollog_fixed_upbo_rules for all to anon, authenticated
  using (false) with check (false);
revoke all on table public.byeollog_fixed_upbo_rules from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.byeollog_fixed_upbo_rules to service_role;

comment on table public.byeollog_fixed_upbo_rules is
  'Service-only fixed Upbo rules applied by the authoritative SOOP SDK collector for exact donation amounts.';

create or replace function public.ingest_soop_core_donation_v1(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_donation_type_label text,p_ceremony_image_url text,
  p_occurred_at timestamptz,p_broadcast_key text,p_release_key text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare
  v_id uuid;v_inserted integer;v_wallpaper boolean:=false;v_source_key text;
  v_fixed_rewards jsonb:='[]'::jsonb;v_source_uid text;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 180
    or char_length(btrim(p_actor_id)) not between 1 and 180
    or char_length(btrim(p_actor_name)) not between 1 and 120
    or p_amount not between 1 and 1000000000 or p_occurred_at is null
  then raise exception 'core SOOP donation is invalid' using errcode='22023'; end if;

  v_source_key:='soop_sdk:'||btrim(p_event_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_name',rule.event_name,'upbo_type',rule.upbo_type,'quantity',rule.quantity)
    order by rule.event_name,rule.upbo_type),'[]'::jsonb)
  into v_fixed_rewards
  from public.byeollog_fixed_upbo_rules rule
  where rule.workspace_id=p_workspace_id and rule.balloons=p_amount;

  insert into public.byeollog_soop_core_donations(
    workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,
    occurred_at,broadcast_key)
  values(p_workspace_id,btrim(p_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,
    coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),p_occurred_at,btrim(p_broadcast_key))
  on conflict(workspace_id,provider_event_id) do nothing
  returning id into v_id;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select donation.id into v_id from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.provider_event_id=btrim(p_event_id);
    if jsonb_array_length(v_fixed_rewards)>0 then v_source_uid:=v_source_key; end if;
    return jsonb_build_object('duplicate',true,'status','duplicate','donationId',v_id,
      'wallpaperRecorded',false,'sourceUid',v_source_uid,'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
  end if;

  v_wallpaper:=byeollog_automation.record_wallpaper_donation_v4(
    p_workspace_id,v_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,
    p_broadcast_key,p_release_key);
  insert into public.bangsel_donations(
    workspace_id,source_event_key,source,donation_type,donated_date,donated_time,donated_at,
    soop_id,nickname,balloons,message,had_roulette,roulette_count,roulette_results,event_name,raw_payload)
  values(p_workspace_id,v_source_key,'soop_chat_sdk',coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),
    (p_occurred_at at time zone 'Asia/Seoul')::date,(p_occurred_at at time zone 'Asia/Seoul')::time,
    p_occurred_at,lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,null,false,0,'[]'::jsonb,null,
    jsonb_build_object('source_provider','soop_chat_sdk','provider_event_id',btrim(p_event_id)))
  on conflict(workspace_id,source_event_key) do nothing;

  if jsonb_array_length(v_fixed_rewards)>0 then
    v_source_uid:=v_source_key;
    insert into public.bangsel_collector_staging(
      workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
      collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
      roulette_results,fixed_rewards,process_status,source_scope,uploaded_at)
    values(p_workspace_id,v_source_uid,btrim(p_broadcast_key),
      to_char(p_occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
      btrim(p_actor_name),lower(btrim(p_actor_id)),p_amount,'','soop-chat-sdk-core-v1',
      jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
        'provider_event_id',btrim(p_event_id),'fixed_classification','server'),
      null,null,0,'unmapped','[]'::jsonb,v_fixed_rewards,'pending','soop',clock_timestamp())
    on conflict(workspace_id,source_uid) do update set
      fixed_rewards=excluded.fixed_rewards,process_status=case
        when bangsel_collector_staging.process_status in ('failed','needs_review') then 'pending'
        else bangsel_collector_staging.process_status end,
      process_error=null,uploaded_at=excluded.uploaded_at;
  end if;

  return jsonb_build_object('duplicate',false,'status','recorded','donationId',v_id,
    'wallpaperRecorded',v_wallpaper,'sourceUid',v_source_uid,
    'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
end
$function$;

revoke all on function public.ingest_soop_core_donation_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_core_donation_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  to service_role;
