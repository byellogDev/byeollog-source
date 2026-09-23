-- Recover only historical subscription rows that can be attached to an
-- already-known wallpaper broadcast round. Do not invent rounds for unmatched
-- staging rows: their original broadcast boundary is not authoritative.

with candidates as (
  select
    staging.workspace_id,
    matched_session.id as session_id,
    (
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),1,8)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),9,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),13,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),17,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),21,12)
    )::uuid as donation_event_id,
    case
      when left(btrim(coalesce(nullif(staging.nickname,''),nullif(staging.soop_id,''),'익명')),120)=''
        or left(btrim(coalesce(nullif(staging.nickname,''),nullif(staging.soop_id,''),'익명')),120)~'[[:cntrl:]]'
      then '익명'
      else left(btrim(coalesce(nullif(staging.nickname,''),nullif(staging.soop_id,''),'익명')),120)
    end as actor_name,
    (staging.raw_payload->>'subscription_months')::integer as months,
    staging.uploaded_at
  from public.bangsel_collector_staging staging
  join lateral (
    select session.id
    from public.byeollog_wallpaper_sessions session
    where session.workspace_id=staging.workspace_id
      and session.started_at<=staging.uploaded_at+interval '2 minutes'
      and coalesce(session.closed_at,session.updated_at)>=staging.uploaded_at-interval '20 minutes'
    order by session.started_at desc
    limit 1
  ) matched_session on true
  where staging.validation='subscription'
    and coalesce(staging.raw_payload->>'collector_event_kind','')='subscription'
    and coalesce(staging.source_uid,'')<>''
    and coalesce(staging.raw_payload->>'subscription_months','')~'^[1-9][0-9]{0,8}$'
    and (staging.raw_payload->>'subscription_months')::integer between 1 and 1000000000
), inserted as (
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,
    display_kind,asset_source,asset,received_at)
  select
    candidate.workspace_id,candidate.session_id,candidate.donation_event_id,
    candidate.actor_name,candidate.months,'subscription','none','{}'::jsonb,
    candidate.uploaded_at
  from candidates candidate
  on conflict(workspace_id,donation_event_id) do nothing
  returning workspace_id,session_id
), session_counts as (
  select inserted.session_id,count(*)::integer as inserted_count
  from inserted
  group by inserted.session_id
), bumped_sessions as (
  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,
    tile_count=session.tile_count+counts.inserted_count,
    updated_at=clock_timestamp()
  from session_counts counts
  where session.id=counts.session_id
  returning session.workspace_id,session.id
)
update public.byeollog_wallpaper_overlay_states overlay set
  revision=overlay.revision+1,
  updated_at=clock_timestamp()
where exists(
  select 1
  from bumped_sessions bumped
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=bumped.workspace_id
   and selected.session_id=bumped.id
  where bumped.workspace_id=overlay.workspace_id
);

comment on function byeollog_automation.capture_wallpaper_subscription_v1() is
  'Captures fresh Collector subscriptions; the 20260831214059 recovery attaches only historically matchable rows to existing wallpaper rounds.';
