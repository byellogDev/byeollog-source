-- Default donation images are an animated-capable common-overlay fallback.
-- Wallpaper deliberately keeps SOOP's provider/default artwork.

drop trigger if exists bump_wallpaper_for_default_image_v1
  on public.byeollog_default_donation_images;
drop function if exists byeollog_automation.bump_wallpaper_for_default_image_v1();

alter table public.byeollog_default_donation_images
  drop constraint if exists byeollog_default_donation_images_wallpaper_image_check;

alter table public.byeollog_default_donation_images
  alter column wallpaper_image drop not null;

alter table public.byeollog_default_donation_images
  add constraint byeollog_default_donation_images_wallpaper_image_check
  check (
    wallpaper_image is null
    or byeollog_automation.is_valid_signature_balloon_asset_v1(
      wallpaper_image,workspace_id,'default-wallpaper'
    )
  );

update public.byeollog_default_donation_images
set wallpaper_image=null,updated_at=clock_timestamp()
where wallpaper_image is not null;

comment on column public.byeollog_default_donation_images.wallpaper_image is
  'Retired compatibility column. Default donation images never override wallpaper artwork.';

create or replace function public.g3a_agent_direct_wallpaper_snapshot_v1(
  p_workspace_id uuid,
  p_known_revision bigint,
  p_device_id uuid,
  p_device_secret_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_context record;
begin
  select context.* into strict v_context
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,p_device_id,p_device_secret_hash
  ) context;
  return public.g3a_get_wallpaper_snapshot_v1(
    p_workspace_id,p_known_revision,p_device_id,p_device_secret_hash,
    v_context.authorized_user_id,v_context.session_id,'agent_runtime',
    v_context.runtime_revision,v_context.db_revision
  );
end
$function$;

revoke all on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  from public,anon,authenticated;
grant execute on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  to authenticated;
