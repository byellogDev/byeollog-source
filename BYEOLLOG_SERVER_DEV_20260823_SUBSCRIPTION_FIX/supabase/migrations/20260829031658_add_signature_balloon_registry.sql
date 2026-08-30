-- Signature balloon registry. The registry is server-only and every image
-- reference is pinned to one workspace and one display role.

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
    and p_kind in ('pc','mobile')
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

revoke all on function byeollog_automation.is_valid_signature_balloon_asset_v1(jsonb,uuid,text)
  from public,anon,authenticated;
grant execute on function byeollog_automation.is_valid_signature_balloon_asset_v1(jsonb,uuid,text)
  to service_role;

create table public.byeollog_signature_balloons (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  balloon_count integer not null check (balloon_count between 1 and 30000),
  display_name text not null,
  pc_image jsonb not null,
  mobile_image jsonb not null,
  version_number integer not null default 1 check (version_number between 1 and 2147483647),
  created_by_user_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,id),
  unique(workspace_id,balloon_count),
  check (display_name=btrim(display_name) and char_length(display_name) between 1 and 80 and display_name!~'[[:cntrl:]]'),
  check (byeollog_automation.is_valid_signature_balloon_asset_v1(pc_image,workspace_id,'pc')),
  check (byeollog_automation.is_valid_signature_balloon_asset_v1(mobile_image,workspace_id,'mobile'))
);

comment on table public.byeollog_signature_balloons is
  'Workspace-private signature balloon registry used by the server-side common overlay image resolver.';

create index byeollog_signature_balloons_workspace_updated_idx
  on public.byeollog_signature_balloons(workspace_id,updated_at desc);

alter table public.byeollog_signature_balloons enable row level security;
create policy explicitly_deny_direct_client_access
  on public.byeollog_signature_balloons for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_signature_balloons from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_signature_balloons to service_role;
