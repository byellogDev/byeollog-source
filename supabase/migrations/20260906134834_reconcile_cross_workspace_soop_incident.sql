create table if not exists private.byeollog_data_correction_audits (
  incident_key text primary key,
  correction_type text not null,
  authoritative_workspace_slug text,
  affected_workspace_slug text,
  snapshot jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

revoke all on table private.byeollog_data_correction_audits
  from public,anon,authenticated,service_role;

create or replace function public.reconcile_cross_workspace_soop_incident_v1(
  p_incident_key text,
  p_authoritative_workspace_slug text,
  p_affected_workspace_slug text,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='2s'
set statement_timeout='20s'
as $function$
declare
  v_authoritative uuid;
  v_affected uuid;
  v_core_count integer;
  v_result_count integer;
  v_tile_count integer;
  v_donation_count integer;
  v_staging_count integer;
  v_task_count integer;
  v_import_count integer;
  v_invalidation_count integer;
  v_observation_count integer;
  v_existing jsonb;
begin
  if char_length(btrim(coalesce(p_incident_key,''))) not between 8 and 120
    or p_authoritative_workspace_slug=p_affected_workspace_slug
    or p_from is null or p_to is null or p_to<=p_from
    or p_to-p_from>interval '24 hours'
  then raise exception 'invalid correction scope' using errcode='22023'; end if;

  select workspace.id into v_authoritative
  from public.byeollog_workspaces workspace
  where workspace.slug=p_authoritative_workspace_slug and workspace.status='active';
  select workspace.id into v_affected
  from public.byeollog_workspaces workspace
  where workspace.slug=p_affected_workspace_slug and workspace.status='active';
  if v_authoritative is null or v_affected is null then
    raise exception 'workspace not found' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog:cross-workspace-correction:'||p_incident_key,0));

  select audit.counts into v_existing
  from private.byeollog_data_correction_audits audit
  where audit.incident_key=p_incident_key and audit.completed_at is not null;
  if v_existing is not null then
    return jsonb_build_object('ok',true,'alreadyCompleted',true,'counts',v_existing);
  end if;

  -- Stop the contaminated consumer before changing any product rows. New
  -- signed events are rejected at the server boundary as soon as this
  -- transaction commits; the worker then exits on its next reconciliation.
  update public.byeollog_soop_runtime_controls control
  set gateway_enabled=false,updated_at=clock_timestamp()
  where control.workspace_id=v_affected;

  create temporary table incident_donations on commit drop as
  select affected.id,affected.provider_event_id
  from public.byeollog_soop_core_donations affected
  where affected.workspace_id=v_affected
    and affected.occurred_at>=p_from and affected.occurred_at<=p_to
    and exists(
      select 1 from public.byeollog_soop_core_donations authoritative
      where authoritative.workspace_id=v_authoritative
        and authoritative.occurred_at=affected.occurred_at
        and authoritative.actor_id=affected.actor_id
        and authoritative.amount=affected.amount
    );

  create temporary table incident_source_keys on commit drop as
  select donation.id,'soop_sdk:'||donation.provider_event_id as source_key
  from incident_donations donation;

  create temporary table incident_results on commit drop as
  select affected.id
  from public.byeollog_soop_core_roulette_results affected
  where affected.workspace_id=v_affected
    and affected.occurred_at>=p_from and affected.occurred_at<=p_to
    and exists(
      select 1 from public.byeollog_soop_core_roulette_results authoritative
      where authoritative.workspace_id=v_authoritative
        and authoritative.occurred_at=affected.occurred_at
        and authoritative.result_text=affected.result_text
        and authoritative.raw_message=affected.raw_message
    );

  create temporary table incident_observations on commit drop as
  select affected.id
  from public.byeollog_soop_event_observations affected
  where affected.workspace_id=v_affected
    and affected.gateway_received_at>=p_from and affected.gateway_received_at<=p_to
    and exists(
      select 1 from public.byeollog_soop_event_observations authoritative
      where authoritative.workspace_id=v_authoritative
        and authoritative.gateway_received_at=affected.gateway_received_at
        and authoritative.event_type=affected.event_type
    );

  create temporary table incident_sessions on commit drop as
  select distinct tile.session_id
  from public.byeollog_wallpaper_tiles tile
  join incident_source_keys source on source.id=tile.donation_event_id
  where tile.workspace_id=v_affected;

  select count(*) into v_core_count from incident_donations;
  select count(*) into v_result_count from incident_results;
  select count(*) into v_observation_count from incident_observations;
  select count(*) into v_tile_count
    from public.byeollog_wallpaper_tiles tile join incident_source_keys source
      on source.id=tile.donation_event_id where tile.workspace_id=v_affected;
  select count(*) into v_donation_count
    from public.bangsel_donations donation join incident_source_keys source
      on source.source_key=donation.source_event_key where donation.workspace_id=v_affected;
  select count(*) into v_staging_count
    from public.bangsel_collector_staging staging join incident_source_keys source
      on source.source_key=staging.source_uid where staging.workspace_id=v_affected;
  select count(*) into v_task_count
    from public.bangsel_tasks task join incident_source_keys source
      on source.source_key=task.source_event_key where task.workspace_id=v_affected;
  select count(*) into v_import_count
    from public.bangsel_task_import_items item join incident_source_keys source
      on source.source_key=item.source_event_key where item.workspace_id=v_affected;
  select count(*) into v_invalidation_count
    from public.bangsel_roulette_invalidations invalidation join incident_source_keys source
      on source.source_key=invalidation.source_uid where invalidation.workspace_id=v_affected;

  if v_core_count<1 then
    raise exception 'no duplicated donations found' using errcode='P0002';
  end if;

  insert into private.byeollog_data_correction_audits(
    incident_key,correction_type,authoritative_workspace_slug,affected_workspace_slug,
    snapshot,counts)
  values(
    p_incident_key,'cross_workspace_soop_room_contamination',
    p_authoritative_workspace_slug,p_affected_workspace_slug,
    jsonb_build_object(
      'scope',jsonb_build_object('from',p_from,'to',p_to),
      'runtimeControl',(select to_jsonb(control) from public.byeollog_soop_runtime_controls control where control.workspace_id=v_affected),
      'coreDonations',coalesce((select jsonb_agg(to_jsonb(row)) from public.byeollog_soop_core_donations row join incident_donations target on target.id=row.id),'[]'::jsonb),
      'rouletteResults',coalesce((select jsonb_agg(to_jsonb(row)) from public.byeollog_soop_core_roulette_results row join incident_results target on target.id=row.id),'[]'::jsonb),
      'wallpaperTiles',coalesce((select jsonb_agg(to_jsonb(row)) from public.byeollog_wallpaper_tiles row join incident_source_keys target on target.id=row.donation_event_id where row.workspace_id=v_affected),'[]'::jsonb),
      'donations',coalesce((select jsonb_agg(to_jsonb(row)) from public.bangsel_donations row join incident_source_keys target on target.source_key=row.source_event_key where row.workspace_id=v_affected),'[]'::jsonb),
      'staging',coalesce((select jsonb_agg(to_jsonb(row)) from public.bangsel_collector_staging row join incident_source_keys target on target.source_key=row.source_uid where row.workspace_id=v_affected),'[]'::jsonb),
      'tasks',coalesce((select jsonb_agg(to_jsonb(row)) from public.bangsel_tasks row join incident_source_keys target on target.source_key=row.source_event_key where row.workspace_id=v_affected),'[]'::jsonb),
      'taskImportItems',coalesce((select jsonb_agg(to_jsonb(row)) from public.bangsel_task_import_items row join incident_source_keys target on target.source_key=row.source_event_key where row.workspace_id=v_affected),'[]'::jsonb),
      'invalidations',coalesce((select jsonb_agg(to_jsonb(row)) from public.bangsel_roulette_invalidations row join incident_source_keys target on target.source_key=row.source_uid where row.workspace_id=v_affected),'[]'::jsonb),
      'observations',coalesce((select jsonb_agg(to_jsonb(row)) from public.byeollog_soop_event_observations row join incident_observations target on target.id=row.id),'[]'::jsonb)
    ),
    jsonb_build_object(
      'coreDonations',v_core_count,'rouletteResults',v_result_count,
      'wallpaperTiles',v_tile_count,'donations',v_donation_count,
      'staging',v_staging_count,'tasks',v_task_count,
      'taskImportItems',v_import_count,'invalidations',v_invalidation_count,
      'observations',v_observation_count
    )
  )
  on conflict(incident_key) do update set
    snapshot=excluded.snapshot,counts=excluded.counts,created_at=clock_timestamp(),completed_at=null;

  delete from public.bangsel_task_import_items item
  using incident_source_keys source
  where item.workspace_id=v_affected and item.source_event_key=source.source_key;
  delete from public.bangsel_tasks task
  using incident_source_keys source
  where task.workspace_id=v_affected and task.source_event_key=source.source_key;
  delete from public.bangsel_roulette_invalidations invalidation
  using incident_source_keys source
  where invalidation.workspace_id=v_affected and invalidation.source_uid=source.source_key;
  delete from public.bangsel_collector_staging staging
  using incident_source_keys source
  where staging.workspace_id=v_affected and staging.source_uid=source.source_key;
  delete from public.bangsel_donations donation
  using incident_source_keys source
  where donation.workspace_id=v_affected and donation.source_event_key=source.source_key;
  delete from public.byeollog_wallpaper_tiles tile
  using incident_source_keys source
  where tile.workspace_id=v_affected and tile.donation_event_id=source.id;
  delete from public.byeollog_soop_core_roulette_results result
  using incident_results target
  where result.id=target.id;
  delete from public.byeollog_soop_core_donations donation
  using incident_donations target
  where donation.id=target.id;

  update public.byeollog_soop_event_observations observation
  set outcome='ignored',
      details=observation.details||jsonb_build_object(
        'reason','cross_workspace_room_contamination',
        'incidentKey',p_incident_key,
        'authoritativeWorkspace',p_authoritative_workspace_slug
      )
  from incident_observations target
  where observation.id=target.id;

  update public.byeollog_wallpaper_sessions session
  set tile_count=(select count(*)::integer from public.byeollog_wallpaper_tiles tile where tile.session_id=session.id),
      revision=session.revision+1,
      updated_at=clock_timestamp()
  where session.workspace_id=v_affected
    and session.id in(select affected.session_id from incident_sessions affected);

  if v_tile_count>0 then
    update public.byeollog_wallpaper_overlay_states overlay
    set revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=v_affected;
  end if;

  update private.byeollog_data_correction_audits audit
  set completed_at=clock_timestamp()
  where audit.incident_key=p_incident_key;

  return jsonb_build_object(
    'ok',true,'gatewayPaused',true,
    'counts',jsonb_build_object(
      'coreDonations',v_core_count,'rouletteResults',v_result_count,
      'wallpaperTiles',v_tile_count,'donations',v_donation_count,
      'staging',v_staging_count,'tasks',v_task_count,
      'taskImportItems',v_import_count,'invalidations',v_invalidation_count,
      'observations',v_observation_count
    )
  );
end
$function$;

revoke all on function public.reconcile_cross_workspace_soop_incident_v1(
  text,text,text,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.reconcile_cross_workspace_soop_incident_v1(
  text,text,text,timestamptz,timestamptz)
  to service_role;


