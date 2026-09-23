-- Reuse the registered common-OBS fallback image for wallpaper donations that
-- arrived without a provider imgUrl. One private upload is the source of truth;
-- the Agent signs and renders that same object instead of storing a duplicate.

create or replace function byeollog_automation.bump_wallpaper_for_default_image_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare v_workspace_id uuid;
begin
  if tg_op='DELETE' then v_workspace_id:=old.workspace_id;
  else v_workspace_id:=new.workspace_id; end if;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id,revision,updated_at)
  values(v_workspace_id,1,clock_timestamp())
  on conflict(workspace_id) do update set
    revision=public.byeollog_wallpaper_overlay_states.revision+1,
    updated_at=clock_timestamp();
  if tg_op='DELETE' then return old; end if;
  return new;
end
$function$;

revoke all on function byeollog_automation.bump_wallpaper_for_default_image_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists bump_wallpaper_for_default_image_v1
  on public.byeollog_default_donation_images;
create trigger bump_wallpaper_for_default_image_v1
after insert or update or delete on public.byeollog_default_donation_images
for each row execute function byeollog_automation.bump_wallpaper_for_default_image_v1();

comment on column public.byeollog_default_donation_images.pc_image is
  'Private animated-capable source reused by common OBS and by wallpaper when a SOOP donation has no provider imgUrl.';

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
declare v_context record;v_result jsonb;v_defaults jsonb;
begin
  select context.* into strict v_context
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,p_device_id,p_device_secret_hash
  ) context;
  v_result:=public.g3a_get_wallpaper_snapshot_v1(
    p_workspace_id,p_known_revision,p_device_id,p_device_secret_hash,
    v_context.authorized_user_id,v_context.session_id,'agent_runtime',
    v_context.runtime_revision,v_context.db_revision
  );
  if coalesce((v_result->>'changed')::boolean,false) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'minAmount',item.min_amount,
      'maxAmount',coalesce(item.max_amount,2147483647),
      'asset',item.pc_image,
      'updatedAt',item.updated_at
    ) order by item.min_amount,item.max_amount nulls last),'[]'::jsonb)
    into v_defaults
    from public.byeollog_default_donation_images item
    where item.workspace_id=p_workspace_id;
    v_result:=v_result||jsonb_build_object('defaultDonationImages',v_defaults);
  end if;
  return v_result;
end
$function$;

revoke all on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  from public,anon,authenticated;
grant execute on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  to authenticated;
