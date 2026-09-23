-- Persistent, user-scoped wallpaper card-width presets. A preset is also
-- copied to the active workspace overlay so new groups can use it without a
-- dashboard session being open.

create or replace function byeollog_automation.is_valid_wallpaper_size_ranges_v1(p_ranges jsonb)
returns boolean
language plpgsql
immutable
set search_path=''
as $function$
declare v_item jsonb;v_min bigint;v_max bigint;v_width bigint;v_previous_max bigint:=null;
begin
  if p_ranges is null or jsonb_typeof(p_ranges)<>'array' or jsonb_array_length(p_ranges)>20 then return false; end if;
  for v_item in
    select item.value from jsonb_array_elements(p_ranges) item(value)
    order by (item.value->>'min')::bigint,(item.value->>'max')::bigint
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item->'min') is distinct from 'number'
      or jsonb_typeof(v_item->'max') is distinct from 'number'
      or jsonb_typeof(v_item->'width') is distinct from 'number'
      or coalesce(v_item->>'min','')!~'^[0-9]+$'
      or coalesce(v_item->>'max','')!~'^[0-9]+$'
      or coalesce(v_item->>'width','')!~'^[0-9]+$'
    then return false; end if;
    v_min:=(v_item->>'min')::bigint;v_max:=(v_item->>'max')::bigint;v_width:=(v_item->>'width')::bigint;
    if v_min not between 1 and 1000000 or v_max not between 1 and 1000000
      or v_min>v_max or v_width not between 80 and 480
      or (v_previous_max is not null and v_min<=v_previous_max)
    then return false; end if;
    v_previous_max:=v_max;
  end loop;
  return true;
exception when others then return false;
end
$function$;

revoke all on function byeollog_automation.is_valid_wallpaper_size_ranges_v1(jsonb)
  from public,anon,authenticated;
grant execute on function byeollog_automation.is_valid_wallpaper_size_ranges_v1(jsonb)
  to service_role;

alter table public.byeollog_wallpaper_overlay_states
  add column size_ranges jsonb not null default '[]'::jsonb
    check (byeollog_automation.is_valid_wallpaper_size_ranges_v1(size_ranges));

alter table public.byeollog_wallpaper_user_settings
  add column size_ranges jsonb not null default '[]'::jsonb
    check (byeollog_automation.is_valid_wallpaper_size_ranges_v1(size_ranges));

create or replace function public.save_wallpaper_size_rules_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_size_ranges jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_ranges jsonb;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0
    or not byeollog_automation.is_valid_wallpaper_size_ranges_v1(p_size_ranges)
  then raise exception 'wallpaper size rules are invalid' using errcode='22023'; end if;
  select coalesce(jsonb_agg(item.value order by (item.value->>'min')::integer,(item.value->>'max')::integer),'[]'::jsonb)
  into v_ranges from jsonb_array_elements(p_size_ranges) item(value);
  select overlay.revision into v_revision
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper size revision conflict' using errcode='40001'; end if;
  insert into public.byeollog_wallpaper_user_settings(workspace_id,user_id,size_ranges,updated_at)
  values(p_workspace_id,p_authorized_user_id,v_ranges,clock_timestamp())
  on conflict(workspace_id,user_id) do update set
    size_ranges=excluded.size_ranges,updated_at=excluded.updated_at;
  update public.byeollog_wallpaper_overlay_states overlay set
    size_ranges=v_ranges,active_settings_user_id=p_authorized_user_id,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_size_rules_v1(uuid,uuid,bigint,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_size_rules_v1(uuid,uuid,bigint,jsonb)
  to service_role;

comment on function public.save_wallpaper_size_rules_v1(uuid,uuid,bigint,jsonb) is
  'Stores non-overlapping per-user donation amount ranges and fixed card widths, and activates them for the workspace overlay.';


