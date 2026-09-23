-- Preserve signatures, permissions and successful behavior; business conflicts are not serialization failures.
begin;
set local lock_timeout='1s';
set local statement_timeout='10s';
CREATE OR REPLACE FUNCTION public.byeollog_commit_upbo_group_v1(p_workspace_id uuid, p_group jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '8s'
AS $function$
declare
  v_keys text[]; v_new text[]; v_ids uuid[]; v_task public.bangsel_tasks%rowtype;
  v_added integer; v_base integer; v_tracked integer;
begin
  if p_workspace_id is null or jsonb_typeof(p_group) is distinct from 'object'
    or jsonb_typeof(p_group->'keys') is distinct from 'array'
    or length(coalesce(p_group->>'type','')) not between 1 and 2000
    or length(coalesce(p_group->>'fan','')) not between 1 and 2000
    or jsonb_array_length(p_group->'keys') not between 1 and 10000 then
    raise exception 'invalid upbo group' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_group->'keys') k where jsonb_typeof(k) is distinct from 'string') then
    raise exception 'invalid upbo keys' using errcode='22023';
  end if;
  select array_agg(distinct k order by k) into v_keys from jsonb_array_elements_text(p_group->'keys') k;
  if exists(select 1 from unnest(v_keys) k where length(k) not between 1 and 4000) then
    raise exception 'invalid upbo key size' using errcode='22023';
  end if;
  -- Same lock as voiding and matching. Covers old and new web processors.
  if coalesce(p_group->>'source','')<>'collector_fixed_rule' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
    -- An old in-flight processor must retry after the web promotion rather
    -- than writing positional keys for a newly identified result.
    if coalesce(p_group->>'receiptProtocol','')<>'2' and exists(
      select 1 from unnest(v_keys) k join public.bangsel_collector_staging s
       on s.workspace_id=p_workspace_id and s.source_uid=split_part(k,'|',1)
      cross join lateral jsonb_array_elements(s.roulette_results) r
      where split_part(k,'|',2)~'^[0-9]+$' and r->>'receipt_identity' like 'result:%') then
      raise exception '룰렛 처리기 업데이트 후 재시도합니다.' using errcode='PT409';
    end if;
    if exists(select 1 from public.bangsel_roulette_invalidations i
      cross join unnest(v_keys) k where i.workspace_id=p_workspace_id
      and (left(k,length(i.source_uid)+1)=i.source_uid||'|'
        or left(k,length(i.source_uid)+8)='weflab:'||i.source_uid||'|')) then
      raise exception '무효 처리된 룰렛은 업보에 등록할 수 없습니다.' using errcode='23514';
    end if;
  end if;
  -- One short transaction per fan/event/type, not a global ingress lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    jsonb_build_array(p_workspace_id,p_group->>'soop_id',p_group->>'event',p_group->>'type')::text,1701));
  select array_agg(k order by k) into v_new from unnest(v_keys) k
    where not exists(select 1 from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id and i.source_event_key=k);
  if coalesce(cardinality(v_new),0)=0 then return jsonb_build_object('taskId',null,'added',0); end if;

  select array_agg(t.id) into v_ids from (
    select id from public.bangsel_tasks where workspace_id=p_workspace_id and done_qty=0
      and fan_soop_id=p_group->>'soop_id' and event=coalesce(p_group->>'event','') and type=p_group->>'type'
      order by id limit 2 for update
  ) t;
  if cardinality(v_ids)=1 then
    select * into v_task from public.bangsel_tasks where id=v_ids[1] and workspace_id=p_workspace_id;
    v_base:=v_task.total_qty;
    select count(*) into v_tracked from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=v_task.id;
    if v_tracked=0 and v_task.source_event_key=any(v_keys)
      and v_task.source in ('weflab_roulette_grouped','soop_chat_sdk_grouped','collector_fixed_grouped') then
      v_base:=0; -- Preserve the existing orphan-before-ledger recovery rule.
    end if;
  else
    insert into public.bangsel_tasks(workspace_id,fan,fan_soop_id,event,type,total_qty,done_qty,memo,added_date,source,source_event_key)
      values(p_workspace_id,p_group->>'fan',nullif(p_group->>'soop_id',''),coalesce(p_group->>'event',''),p_group->>'type',1,0,'',
        (p_group->>'added_date')::date,coalesce(p_group->>'taskSource','weflab_roulette_grouped'),p_workspace_id::text||':'||v_new[1])
      returning * into v_task;
    v_base:=0;
  end if;
  insert into public.bangsel_task_import_items(workspace_id,source_event_key,task_id,source)
    select p_workspace_id,k,v_task.id,coalesce(p_group->>'source','weflab_roulette') from unnest(v_new) k;
  get diagnostics v_added=row_count;
  update public.bangsel_tasks set total_qty=greatest(1,v_base+v_added) where id=v_task.id and workspace_id=p_workspace_id;
  return jsonb_build_object('taskId',v_task.id,'added',v_added);
end $function$
;

CREATE OR REPLACE FUNCTION public.clear_wallpaper_layout_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_session_id uuid, p_expected_revision bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  select session.revision into v_revision
  from public.byeollog_wallpaper_sessions session
  where session.id=p_session_id and session.workspace_id=p_workspace_id and session.state='active'
  for update;
  if not found then raise exception 'wallpaper session was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then
    raise exception 'wallpaper layout revision conflict' using errcode='PT409';
  end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id and stored.session_id=p_session_id
    and stored.layout_x is not null;
  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,updated_at=clock_timestamp()
  where session.id=p_session_id
  returning session.revision into v_revision;
  return v_revision;
end
$function$
;

CREATE OR REPLACE FUNCTION public.clear_wallpaper_overlay_layout_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='PT409'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,
    layout_columns=null,layout_rows=null,layout_next_side=null,layout_layer=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id
    and (stored.layout_x is not null or stored.layout_layer is not null)
    and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=p_workspace_id and selected.session_id=stored.session_id);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$
;

CREATE OR REPLACE FUNCTION public.save_wallpaper_layout_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_session_id uuid, p_expected_revision bigint, p_tiles jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare
  v_revision bigint;
  v_tile_count integer;
  v_matched_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);

  if p_session_id is null or p_expected_revision is null or p_expected_revision < 0
    or p_tiles is null
    or jsonb_typeof(p_tiles) <> 'array'
    or jsonb_array_length(p_tiles) > 108
  then raise exception 'wallpaper layout request is invalid' using errcode='22023'; end if;

  select session.revision into v_revision
  from public.byeollog_wallpaper_sessions session
  where session.id=p_session_id and session.workspace_id=p_workspace_id and session.state='active'
  for update;
  if not found then raise exception 'wallpaper session was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then
    raise exception 'wallpaper layout revision conflict' using errcode='PT409';
  end if;

  select count(*) into v_tile_count from jsonb_array_elements(p_tiles) item;
  if exists(
    select 1 from jsonb_array_elements(p_tiles) item
    where jsonb_typeof(item)<>'object'
      or jsonb_typeof(item->'id')<>'string'
      or jsonb_typeof(item->'x')<>'number'
      or jsonb_typeof(item->'y')<>'number'
      or jsonb_typeof(item->'width')<>'number'
      or jsonb_typeof(item->'height')<>'number'
      or (item->>'x')!~'^[-]?[0-9]+$'
      or (item->>'y')!~'^[-]?[0-9]+$'
      or (item->>'width')!~'^[0-9]+$'
      or (item->>'height')!~'^[0-9]+$'
  ) then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;

  if exists(
    select 1
    from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60
      or tile.x+tile.width>1920 or tile.y+tile.height>1080
  ) then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;

  if (
    select count(distinct tile.id)
    from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
  )<>v_tile_count then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;

  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
    on tile.id=stored.id
  where stored.workspace_id=p_workspace_id and stored.session_id=p_session_id;
  if v_matched_count<>v_tile_count then
    raise exception 'wallpaper tile does not belong to the active session' using errcode='22023';
  end if;

  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,
    layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id and stored.session_id=p_session_id;

  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,updated_at=clock_timestamp()
  where session.id=p_session_id
  returning session.revision into v_revision;
  return v_revision;
end
$function$
;

CREATE OR REPLACE FUNCTION public.save_wallpaper_overlay_layout_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint, p_tiles jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;v_tile_count integer;v_matched_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_tiles is null
    or jsonb_typeof(p_tiles)<>'array' or jsonb_array_length(p_tiles)>216
  then raise exception 'wallpaper layout request is invalid' using errcode='22023'; end if;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='PT409'; end if;
  select count(*) into v_tile_count from jsonb_array_elements(p_tiles);
  if exists(select 1 from jsonb_array_elements(p_tiles) item where jsonb_typeof(item)<>'object'
    or jsonb_typeof(item->'id')<>'string' or (item->>'x')!~'^[0-9]+$' or (item->>'y')!~'^[0-9]+$'
    or (item->>'width')!~'^[0-9]+$' or (item->>'height')!~'^[0-9]+$'
    or (item->>'columns')!~'^[0-9]+$' or (item->>'rows')!~'^[0-9]+$')
  then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60 or tile.x+tile.width>1920 or tile.y+tile.height>1080
      or tile.columns not between 1 and 13 or tile.rows not between 1 and 216)
  then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;
  if (select count(distinct tile.id) from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer))<>v_tile_count
  then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer) on tile.id=stored.id
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=stored.workspace_id and selected.session_id=stored.session_id
  where stored.workspace_id=p_workspace_id;
  if v_matched_count<>v_tile_count then raise exception 'wallpaper tile is not selected' using errcode='22023'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,
    layout_columns=tile.columns,layout_rows=tile.rows,layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id;
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$
;

CREATE OR REPLACE FUNCTION public.save_wallpaper_visibility_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint, p_hide_below integer, p_hidden_amounts integer[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;v_hidden integer[];
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_hide_below not between 0 and 1000000
    or cardinality(coalesce(p_hidden_amounts,'{}'::integer[]))>100
    or exists(select 1 from unnest(coalesce(p_hidden_amounts,'{}'::integer[])) amount where amount not between 1 and 1000000)
  then raise exception 'wallpaper visibility request is invalid' using errcode='22023'; end if;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper visibility revision conflict' using errcode='PT409'; end if;
  select coalesce(array_agg(distinct amount order by amount),'{}'::integer[]) into v_hidden
  from unnest(coalesce(p_hidden_amounts,'{}'::integer[])) amount;
  update public.byeollog_wallpaper_overlay_states overlay set
    hide_below=p_hide_below,hidden_amounts=v_hidden,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$
;
notify pgrst, 'reload schema';
commit;
