alter table public.byeollog_native_roulette_services
  alter column overlay_layouts set default
    '{"roulette":{"positionXPercent":50,"positionYPercent":38,"scalePercent":100},"roulette_result":{"positionXPercent":50,"positionYPercent":72,"scalePercent":100}}'::jsonb;

update public.byeollog_native_roulette_services
set overlay_layouts=jsonb_set(
  overlay_layouts,'{roulette_result}',
  '{"positionXPercent":50,"positionYPercent":72,"scalePercent":100}'::jsonb,true)
where not overlay_layouts?'roulette_result';

alter table public.byeollog_native_roulette_services
  drop constraint if exists byeollog_native_roulette_services_overlay_layouts_check;
alter table public.byeollog_native_roulette_services
  add constraint byeollog_native_roulette_services_overlay_layouts_check check (
    jsonb_typeof(overlay_layouts)='object'
    and jsonb_typeof(overlay_layouts->'roulette')='object'
    and jsonb_typeof(overlay_layouts->'roulette_result')='object'
    and (overlay_layouts->'roulette'->>'positionXPercent')::integer between 0 and 100
    and (overlay_layouts->'roulette'->>'positionYPercent')::integer between 0 and 100
    and (overlay_layouts->'roulette'->>'scalePercent')::integer between 0 and 200
    and (overlay_layouts->'roulette_result'->>'positionXPercent')::integer between 0 and 100
    and (overlay_layouts->'roulette_result'->>'positionYPercent')::integer between 0 and 100
    and (overlay_layouts->'roulette_result'->>'scalePercent')::integer between 0 and 200
    and (overlay_preview_request is null or jsonb_typeof(overlay_preview_request)='object')
  );

create or replace function public.update_overlay_part_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_part_key text,
  p_position_x_percent integer,p_position_y_percent integer,p_scale_percent integer)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_service public.byeollog_native_roulette_services%rowtype;v_layout jsonb;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  if p_part_key not in ('roulette','roulette_result')
     or p_position_x_percent not between 0 and 100
     or p_position_y_percent not between 0 and 100
     or p_scale_percent not between 0 and 200
  then raise exception 'overlay part layout is invalid' using errcode='22023'; end if;
  v_layout:=jsonb_build_object(
    'positionXPercent',p_position_x_percent,
    'positionYPercent',p_position_y_percent,
    'scalePercent',p_scale_percent);
  update public.byeollog_native_roulette_services set
    overlay_layouts=jsonb_set(overlay_layouts,array[p_part_key],v_layout,true),
    updated_at=clock_timestamp()
  where workspace_id=p_workspace_id returning * into v_service;
  if not found then raise exception 'native roulette service was not found' using errcode='P0002'; end if;
  return v_layout||jsonb_build_object('partKey',p_part_key,'updatedAt',v_service.updated_at);
end
$function$;

revoke all on function public.update_overlay_part_layout_v1(uuid,uuid,text,integer,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.update_overlay_part_layout_v1(uuid,uuid,text,integer,integer,integer)
  to service_role;

;
