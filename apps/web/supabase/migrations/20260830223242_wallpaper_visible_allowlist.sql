-- Wallpaper groups are opt-in. Newly observed amounts appear only in the web
-- catalog until the streamer explicitly adds them to the OBS allowlist.

alter table public.byeollog_wallpaper_overlay_states
  add column visible_group_keys text[] not null default '{}'::text[],
  add constraint byeollog_wallpaper_overlay_visible_group_keys_size_check
    check (cardinality(visible_group_keys)<=500);

create or replace function public.save_wallpaper_visible_keys_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_visible_keys text[])
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_keys text[];
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_visible_keys is null
    or cardinality(p_visible_keys)>500
    or exists(select 1 from unnest(p_visible_keys) key where key!~'^(donation|challenge_success):[1-9][0-9]{0,9}$')
  then raise exception 'wallpaper visible keys request is invalid' using errcode='22023'; end if;
  select coalesce(array_agg(distinct key order by key),'{}'::text[]) into v_keys
  from unnest(p_visible_keys) key;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper visibility revision conflict' using errcode='40001'; end if;
  update public.byeollog_wallpaper_overlay_states overlay set
    visible_group_keys=v_keys,hide_below=0,hidden_amounts='{}'::integer[],
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_visible_keys_v1(uuid,uuid,bigint,text[])
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_visible_keys_v1(uuid,uuid,bigint,text[])
  to service_role;

comment on column public.byeollog_wallpaper_overlay_states.visible_group_keys is
  'Explicit OBS allowlist. New donation amounts remain hidden until selected in the wallpaper catalog.';
