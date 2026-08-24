do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_windows_overlay_guard constant text :=
    '     or (p_action_type = ''windows.mic_mute_for'' and p_overlay_asset_id is not null)';
begin
  select p.oid
    into strict v_function_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'byeollog_automation'
    and p.proname = 'save_guided_rule_compat_v1'
    and p.oid::regprocedure::text =
      'byeollog_automation.save_guided_rule_compat_v1(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,uuid,integer)';

  v_definition := pg_get_functiondef(v_function_oid);
  if strpos(v_definition, v_windows_overlay_guard) = 0 then
    raise exception 'expected Windows overlay guard was not found';
  end if;

  execute replace(v_definition, v_windows_overlay_guard, '');
end
$migration$;

insert into public.overlay_asset_durations (overlay_asset_id, duration_ms)
select a.id, seconds.value * 1000
from public.overlay_assets a
cross join generate_series(1, 240) as seconds(value)
where a.id = '27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc'::uuid
  and a.asset_key = 'microphone_off'
  and a.version_number = 1
  and a.delivery_mode = 'builtin'
  and a.mime_type = 'image/svg+xml'
  and a.content_sha256 = 'e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b'
  and a.byte_size = 1926
  and a.width_px = 1200
  and a.height_px = 360
  and a.retired_at is null
on conflict (overlay_asset_id, duration_ms) do nothing;
