-- Keep the clean image used by a future "풍벽지" renderer separate from
-- the PC/mobile ceremony images. Existing registrations remain valid.

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
    and p_kind in ('pc','mobile','wallpaper')
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

alter table public.byeollog_signature_balloons
  add column if not exists wallpaper_image jsonb;

alter table public.byeollog_signature_balloons
  add constraint byeollog_signature_balloons_wallpaper_image_check
  check (
    wallpaper_image is null
    or byeollog_automation.is_valid_signature_balloon_asset_v1(
      wallpaper_image,workspace_id,'wallpaper'
    )
  );

comment on column public.byeollog_signature_balloons.wallpaper_image is
  'Server-derived 320x240 standalone image reserved for future stacked wallpaper rendering; never combined with roulette result UI. Nullable only for pre-migration rows.';

-- The common overlay may use only a registered ceremony image or the imageUrl
-- delivered by SOOP. There is deliberately no Byeollog-generated fallback.
create or replace function public.ingest_native_overlay_soop_donation_v3(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_result jsonb;v_event_id uuid;v_signature jsonb;v_ceremony jsonb;
  v_roulette_count integer:=0;
begin
  if p_ceremony_image_url is not null and (
    char_length(p_ceremony_image_url)>2048
    or p_ceremony_image_url~'[[:cntrl:]]'
    or lower(p_ceremony_image_url)!~'^https://([a-z0-9-]+\.)*(sooplive\.com|afreecatv\.com|afreecatvcdn\.com)(/|$)'
  ) then
    raise exception 'SOOP ceremony image URL is invalid' using errcode='22023';
  end if;

  v_result:=public.ingest_native_roulette_soop_donation_v2(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,p_occurred_at);
  if coalesce((v_result->>'duplicate')::boolean,false) then return v_result; end if;
  v_event_id:=(v_result->>'eventId')::uuid;

  if p_amount between 1 and 30000 then
    select row.pc_image into v_signature
    from public.byeollog_signature_balloons row
    where row.workspace_id=p_workspace_id and row.balloon_count=p_amount::integer;
  end if;

  v_ceremony:=case
    when v_signature is not null then jsonb_build_object(
      'source','signature','asset',v_signature,'providerUrl',p_ceremony_image_url)
    when p_ceremony_image_url is not null then jsonb_build_object(
      'source','soop','url',p_ceremony_image_url)
    else jsonb_build_object('source','none')
  end;

  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    set payload=jsonb_set(outbox.payload,'{ceremony}',v_ceremony,true)
  where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
    and outbox.command_kind='roulette_spin';
  get diagnostics v_roulette_count=row_count;

  if v_roulette_count=0 then
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,command_kind,payload,expires_at)
    values(p_workspace_id,v_event_id,'donation_ceremony',jsonb_build_object(
      'schemaVersion',4,'kind','donation_ceremony','donationEventId',btrim(p_event_id),
      'actor',jsonb_build_object('name',btrim(p_actor_name)),
      'amount',p_amount,'ceremony',v_ceremony),clock_timestamp()+interval '2 minutes');
  end if;
  return v_result||jsonb_build_object('ceremonyQueued',true,'ceremonySource',v_ceremony->>'source');
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) to service_role;

comment on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) is
  'Queues common-overlay presentation with priority: workspace signature, SOOP imageUrl, or no image. No local fallback is permitted.';


