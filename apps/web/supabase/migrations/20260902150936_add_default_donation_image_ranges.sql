-- Workspace-defined fallback donation images. These are used only when an
-- ordinary SOOP donation has neither an exact signature nor a provider image.

create or replace function byeollog_automation.is_valid_signature_balloon_asset_v1(
  p_asset jsonb,
  p_workspace_id uuid,
  p_kind text
) returns boolean
language sql
immutable
set search_path=''
as $function$
  select p_asset is not null
    and jsonb_typeof(p_asset)='object'
    and p_kind in ('pc','mobile','wallpaper','default-pc','default-wallpaper')
    and (p_asset->>'storagePath') like ('workspaces/'||p_workspace_id::text||'/'||p_kind||'/%')
    and (p_asset->>'mimeType') in ('image/png','image/jpeg','image/webp','image/gif')
    and case when (p_asset->>'byteSize')~'^[1-9][0-9]{0,7}$'
      then (p_asset->>'byteSize')::bigint between 1 and 12582912 else false end
    and case when (p_asset->>'width')~'^[1-9][0-9]{0,3}$'
      then (p_asset->>'width')::integer between 1 and 4096 else false end
    and case when (p_asset->>'height')~'^[1-9][0-9]{0,3}$'
      then (p_asset->>'height')::integer between 1 and 4096 else false end
    and (p_asset->>'sha256')~'^[0-9a-f]{64}$';
$function$;

create table public.byeollog_default_donation_images (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  min_amount integer not null check (min_amount between 1 and 1000000),
  max_amount integer not null check (max_amount between min_amount and 1000000),
  pc_image jsonb not null,
  wallpaper_image jsonb not null,
  version_number integer not null default 1 check (version_number between 1 and 2147483647),
  created_by_user_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,id),
  check (byeollog_automation.is_valid_signature_balloon_asset_v1(pc_image,workspace_id,'default-pc')),
  check (byeollog_automation.is_valid_signature_balloon_asset_v1(wallpaper_image,workspace_id,'default-wallpaper'))
);

comment on table public.byeollog_default_donation_images is
  'Workspace-private, non-overlapping amount ranges used only as ordinary-donation fallback imagery.';

create index byeollog_default_donation_images_workspace_range_idx
  on public.byeollog_default_donation_images(workspace_id,min_amount,max_amount);

create or replace function byeollog_automation.guard_default_donation_image_range_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  -- Serialize range writes per workspace so concurrent requests cannot create
  -- an ambiguous overlap even though the API also validates it.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 9137421));
  if exists (
    select 1 from public.byeollog_default_donation_images existing
    where existing.workspace_id=new.workspace_id
      and existing.id<>new.id
      and int4range(existing.min_amount,existing.max_amount,'[]')
        && int4range(new.min_amount,new.max_amount,'[]')
  ) then
    raise exception 'default donation image ranges overlap' using errcode='23P01';
  end if;
  return new;
end
$function$;

create trigger guard_default_donation_image_range_v1
before insert or update of workspace_id,min_amount,max_amount
on public.byeollog_default_donation_images
for each row execute function byeollog_automation.guard_default_donation_image_range_v1();

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

create trigger bump_wallpaper_for_default_image_v1
after insert or update or delete on public.byeollog_default_donation_images
for each row execute function byeollog_automation.bump_wallpaper_for_default_image_v1();

alter table public.byeollog_default_donation_images enable row level security;
create policy explicitly_deny_direct_client_access
  on public.byeollog_default_donation_images for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_default_donation_images from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_default_donation_images to service_role;

-- Add custom defaults to the raw Agent snapshot without changing the stable
-- authenticated snapshot contract or incurring another network request.
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
      'minAmount',item.min_amount,'maxAmount',item.max_amount,
      'asset',item.wallpaper_image,'updatedAt',item.updated_at
    ) order by item.min_amount,item.max_amount),'[]'::jsonb)
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

-- Agent uses authenticated object URLs for private wallpaper images.
create or replace function byeollog_automation.can_read_signature_asset_v1(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
set statement_timeout='3s'
as $function$
  select p_bucket_id='byeollog-signature-assets'
    and p_object_name ~ '^workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(wallpaper|default-wallpaper)/'
    and exists (
      select 1 from public.byeollog_workspace_members member
      join public.byeollog_workspaces workspace
        on workspace.id=member.workspace_id and workspace.status='active'
      where member.user_id=(select auth.uid())
        and member.role in ('owner','manager')
        and member.workspace_id=split_part(p_object_name,'/',2)::uuid
    );
$function$;
