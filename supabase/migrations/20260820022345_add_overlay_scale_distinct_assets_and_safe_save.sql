-- Additive v0.7.0.18 automation contract.
--
-- This migration intentionally does not drop or relax rule_actions_target_safe.
-- v6 first delegates the proven rule/condition lifecycle to compat_v1 without an
-- overlay, then attaches the exact built-in asset by UUID. The automation mirror
-- stores overlayAssetId instead of overlayAssetKey, so the existing safety check
-- remains intact while v0.7.0.18 Agents resolve only a compiled UUID allowlist.

insert into public.overlay_assets (
  id,asset_key,version_number,display_name,mime_type,content_sha256,
  byte_size,width_px,height_px,delivery_mode,retired_at
)
values
  (
    'b3bbf63e-4464-560d-aaa6-87bb7477ffa9'::uuid,
    'mic_off_badge',1,'마이크 OFF · 방송 배지','image/png',
    'c18ca005d58c084739af8cbe8b93f26154cc4199f21da27faa919920bad7206c',
    1324404,1254,1254,'builtin',null
  ),
  (
    'd2c2798e-643c-57e6-a0fa-495380e24553'::uuid,
    'mic_off_quiet',1,'마이크 OFF · 조용한 구름','image/png',
    '2a5150bdc57ed43f0ea970e21b888a87a1ecf65d241f413d419e12cb60c9d2b8',
    777095,1254,1254,'builtin',null
  )
on conflict (id) do nothing;

insert into public.overlay_asset_durations (overlay_asset_id,duration_ms)
select asset.id,seconds.value*1000
from public.overlay_assets asset
cross join generate_series(1,240) as seconds(value)
where asset.id in (
    'b3bbf63e-4464-560d-aaa6-87bb7477ffa9'::uuid,
    'd2c2798e-643c-57e6-a0fa-495380e24553'::uuid
  )
  and asset.retired_at is null
on conflict (overlay_asset_id,duration_ms) do nothing;

create or replace function byeollog_automation.save_guided_rule_v6_impl(
  p_workspace_id uuid,
  p_name text,
  p_enabled boolean,
  p_priority integer,
  p_source text,
  p_event_type text,
  p_subtype text,
  p_result text,
  p_min_amount bigint,
  p_action_type text,
  p_event_name text,
  p_output_types text[],
  p_quantity integer,
  p_duration_seconds integer,
  p_agent_device_id uuid,
  p_overlay_asset_id uuid,
  p_overlay_position_x integer,
  p_overlay_position_y integer,
  p_overlay_scale_percent integer,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_uid uuid;
  v_rule_id uuid;
  v_rule_version integer;
  v_created_enabled boolean;
  v_asset_key text;
  v_params jsonb;
begin
  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();

  if (p_overlay_position_x is null) <> (p_overlay_position_y is null)
     or (p_overlay_asset_id is null and (
           p_overlay_position_x is not null or p_overlay_scale_percent is not null
        ))
     or (p_overlay_asset_id is not null and (
           p_overlay_position_x is null
           or p_overlay_scale_percent is null
           or p_overlay_position_x not between 0 and 10000
           or p_overlay_position_y not between 0 and 10000
           or p_overlay_scale_percent not between 25 and 200
        ))
  then
    raise exception 'overlay placement is invalid' using errcode='22023';
  end if;

  if p_overlay_asset_id is not null then
    select a.asset_key
      into v_asset_key
    from public.overlay_assets a
    where a.id=p_overlay_asset_id
      and a.version_number=1
      and a.delivery_mode='builtin'
      and a.retired_at is null
      and (
        (a.id='f7ae3370-5e3c-5061-958b-c7c402c590c6'::uuid
          and a.asset_key='mic_off_center'
          and a.content_sha256='70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464'
          and a.byte_size=335254)
        or (a.id='f831caee-6953-51f9-9eee-9cfb66e96fc4'::uuid
          and a.asset_key='mic_off_top_left'
          and a.content_sha256='70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464'
          and a.byte_size=335254)
        or (a.id='e745492e-4420-52e8-9a2b-36f53144c1c8'::uuid
          and a.asset_key='mic_off_top_right'
          and a.content_sha256='70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464'
          and a.byte_size=335254)
        or (a.id='b3bbf63e-4464-560d-aaa6-87bb7477ffa9'::uuid
          and a.asset_key='mic_off_badge'
          and a.content_sha256='c18ca005d58c084739af8cbe8b93f26154cc4199f21da27faa919920bad7206c'
          and a.byte_size=1324404)
        or (a.id='d2c2798e-643c-57e6-a0fa-495380e24553'::uuid
          and a.asset_key='mic_off_quiet'
          and a.content_sha256='2a5150bdc57ed43f0ea970e21b888a87a1ecf65d241f413d419e12cb60c9d2b8'
          and a.byte_size=777095)
      )
      and a.mime_type='image/png'
      and a.width_px=1254
      and a.height_px=1254;

    if not found or not exists (
      select 1 from public.overlay_asset_durations d
      where d.overlay_asset_id=p_overlay_asset_id
        and d.duration_ms=p_duration_seconds*1000
    ) then
      raise exception 'approved built-in overlay revision is required' using errcode='22023';
    end if;
  end if;

  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_compat_v1(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
    p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
    p_duration_seconds,p_agent_device_id,null,p_replace_rule_id,p_expected_version
  ) saved;

  if p_overlay_asset_id is not null then
    v_params := jsonb_build_object(
      'overlayAssetId',p_overlay_asset_id::text,
      'overlayPositionX',p_overlay_position_x,
      'overlayPositionY',p_overlay_position_y,
      'overlayScalePercent',p_overlay_scale_percent
    );

    update public.rule_actions
       set overlay_asset_id=p_overlay_asset_id,
           overlay_duration_ms=p_duration_seconds*1000,
           params=params || v_params
     where rule_id=v_rule_id
       and action_type=p_action_type;
    if not found then
      raise exception 'saved overlay action was not found' using errcode='P0002';
    end if;

    update byeollog_automation.rule_actions
       set params=params || v_params
     where rule_id=v_rule_id
       and action_type=p_action_type;
    if not found then
      raise exception 'saved automation mirror action was not found' using errcode='P0002';
    end if;
  end if;

  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v6_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,integer,uuid,integer
) from public,anon;
grant execute on function byeollog_automation.save_guided_rule_v6_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,integer,uuid,integer
) to authenticated;

create or replace function public.save_guided_rule_v6(
  p_workspace_id uuid,
  p_name text,
  p_enabled boolean,
  p_priority integer,
  p_source text,
  p_event_type text,
  p_subtype text,
  p_result text,
  p_min_amount bigint,
  p_action_type text,
  p_event_name text,
  p_output_types text[],
  p_quantity integer,
  p_duration_seconds integer,
  p_agent_device_id uuid,
  p_overlay_asset_id uuid,
  p_overlay_position_x integer,
  p_overlay_position_y integer,
  p_overlay_scale_percent integer,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
set search_path = ''
as $function$
  select * from byeollog_automation.save_guided_rule_v6_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
    p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
    p_duration_seconds,p_agent_device_id,p_overlay_asset_id,p_overlay_position_x,
    p_overlay_position_y,p_overlay_scale_percent,p_replace_rule_id,p_expected_version
  )
$function$;

revoke all on function public.save_guided_rule_v6(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,integer,uuid,integer
) from public,anon;
grant execute on function public.save_guided_rule_v6(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,integer,uuid,integer
) to authenticated;

do $migration$
begin
  if (select count(*) from public.overlay_assets
      where retired_at is null
        and (
          (id='b3bbf63e-4464-560d-aaa6-87bb7477ffa9'::uuid
            and asset_key='mic_off_badge'
            and content_sha256='c18ca005d58c084739af8cbe8b93f26154cc4199f21da27faa919920bad7206c'
            and byte_size=1324404 and width_px=1254 and height_px=1254
            and mime_type='image/png' and delivery_mode='builtin')
          or
          (id='d2c2798e-643c-57e6-a0fa-495380e24553'::uuid
            and asset_key='mic_off_quiet'
            and content_sha256='2a5150bdc57ed43f0ea970e21b888a87a1ecf65d241f413d419e12cb60c9d2b8'
            and byte_size=777095 and width_px=1254 and height_px=1254
            and mime_type='image/png' and delivery_mode='builtin')
        )) <> 2
     or (select count(*) from public.overlay_asset_durations
         where overlay_asset_id in (
           'b3bbf63e-4464-560d-aaa6-87bb7477ffa9'::uuid,
           'd2c2798e-643c-57e6-a0fa-495380e24553'::uuid
         ) and duration_ms between 1000 and 240000
           and duration_ms % 1000 = 0) <> 480
     or to_regprocedure(
       'public.save_guided_rule_v6(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,integer,integer,integer,uuid,integer)'
     ) is null
  then
    raise exception 'v0.7.0.18 overlay/save contract verification failed';
  end if;
end
$migration$;


