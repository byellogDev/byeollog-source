begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create trigger zz_snapshot_upbo_collection before insert on public.byeollog_soop_core_donations
 for each row execute function private.snapshot_upbo_collection_v1();
create trigger aa_guard_upbo_staging before insert or update on public.bangsel_collector_staging
 for each row execute function private.guard_upbo_staging_v1();
do $patch$
declare f text;marker text;replacement text;
begin
 f:=pg_get_functiondef('public.apply_roulette_amount_mapping_to_staging_v1()'::regprocedure);
 marker:='begin';
 if strpos(lower(f),marker)=0 then raise exception 'collection staging name definition drift'; end if;
 -- New names have a donation-time snapshot. Old mapping triggers must not overwrite it.
 f:=regexp_replace(f,'\m[Bb][Ee][Gg][Ii][Nn]\M',$new$begin
  if exists(select 1 from public.byeollog_soop_core_donations d where d.workspace_id=new.workspace_id
    and 'soop_sdk:'||d.provider_event_id=new.source_uid and d.upbo_collection_managed) then return new; end if;$new$);
 execute f;
 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)'::regprocedure);
 marker:=$old$if not exists(select 1 from public.byeollog_roulette_amount_mappings m
      where m.workspace_id=p_workspace_id and m.enabled) then$old$;
 if strpos(f,marker)=0 then raise exception 'collection gate definition drift'; end if;
 f:=replace(f,marker,'if not private.upbo_collection_enabled_v1(p_workspace_id) then');
 execute f;

 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v2(uuid,text,text,text,text,text,text,text,timestamptz,text)'::regprocedure);
 marker:='if v_donation.id is not null then';
 if strpos(f,marker)=0 then raise exception 'collection FIFO definition drift'; end if;
 f:=replace(f,marker,$guard$if exists(select 1 from public.byeollog_soop_core_donations d
    where d.workspace_id=p_workspace_id and d.upbo_collection_issue is not null and d.user_closed_at is null
      and private.same_soop_broadcast_v1(p_workspace_id,d.id,d.broadcast_key,btrim(p_broadcast_key))
      and d.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
      and (v_donation.id is null or (d.occurred_at,d.id)<=(v_donation.occurred_at,v_donation.id))) then
    update public.byeollog_soop_core_roulette_results set match_state='ambiguous',match_method='overlay_settings_unavailable'
      where id=v_result_id;
    return jsonb_build_object('duplicate',false,'matched',false,'status','overlay_settings_unavailable');
  end if;
  if v_donation.id is not null then$guard$);
 marker:=$old$v_event_name:=v_donation.roulette_name;$old$;
 if strpos(f,marker)=0 then raise exception 'collection event name definition drift'; end if;
 replacement:=$new$if v_donation.upbo_collection_managed then
    v_event_name:=coalesce(v_donation.upbo_event_name,
      extract(month from (coalesce((select min(r.occurred_at) from public.byeollog_soop_core_roulette_results r
        where r.workspace_id=p_workspace_id and r.donation_id=v_donation.id),p_occurred_at) at time zone 'Asia/Seoul'))::integer::text
      ||'월 '||v_donation.amount::text||'개');
    update public.byeollog_soop_core_donations set upbo_event_name=v_event_name where id=v_donation.id and workspace_id=p_workspace_id;
  else
    v_event_name:=v_donation.roulette_name;
  end if;$new$;
 execute replace(f,marker,replacement);

end $patch$;

update public.byeollog_soop_runtime_controls set upbo_settings_protocol=1;
notify pgrst,'reload schema';
commit;
