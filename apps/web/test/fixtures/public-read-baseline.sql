CREATE OR REPLACE FUNCTION public.byeollog_public_upbo_page_v1(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v jsonb;
begin
  if p_page is null or p_page not between 0 and 2000 or p_sort not in ('name','remaining','newest')
    or char_length(coalesce(p_search,''))>100 then raise exception 'invalid public page' using errcode='22023';end if;
  with ws as (
    select id from public.byeollog_workspaces where slug=lower(btrim(p_workspace_slug))
      and status='active' and coalesce(public_page_enabled,true) limit 1
  ), base as (
    select t.id,t.fan,t.event,t.type,t.created_at,greatest(t.total_qty-t.done_qty,0) as remaining,
      coalesce(nullif(lower(btrim(t.fan_soop_id)),''),'legacy:'||coalesce(t.fan,'')) as identity,
      split_part(replace(replace(coalesce(t.public_comment,''),E'\r\n',E'\n'),E'\r',E'\n'),E'\n',1) as comment
    from public.bangsel_tasks t join ws on ws.id=t.workspace_id
    where t.total_qty>t.done_qty and (
      nullif(btrim(p_search),'') is null
      or position(lower(p_search) in lower(coalesce(t.fan,'')))>0
      or position(lower(p_search) in lower(coalesce(t.fan_soop_id,'')))>0
      or exists(select 1 from public.bangsel_fans f where f.workspace_id=t.workspace_id and f.soop_id=t.fan_soop_id
        and (position(lower(p_search) in lower(coalesce(f.alias,'')))>0
          or position(lower(p_search) in lower(coalesce(f.current_nickname,'')))>0))
    )
  ), ranked as (
    select b.*,sum(remaining) over(partition by identity) as fan_remaining,
      row_number() over(order by case when p_sort='remaining' then remaining end desc nulls last,
        case when p_sort='newest' then created_at end desc nulls last,fan,identity,event,type,created_at,id) as ordinal
    from base b
  ), page as (select * from ranked where ordinal>p_page*50 and ordinal<=p_page*50+51)
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'ordinal' order by ordinal) from page p where ordinal<=p_page*50+50),'[]'::jsonb),
    'hasMore',exists(select 1 from page where ordinal>p_page*50+50),'totalRows',(select count(*) from base),'page',p_page) into v;
  return v;
end $function$;


CREATE OR REPLACE FUNCTION public.byeollog_public_viewer_snapshot_v1(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare workspace jsonb; page_data jsonb;
begin
  if p_page is null or p_page not between 0 and 2000 or p_sort is null or p_sort not in ('name','remaining','newest')
    or char_length(coalesce(p_search,''))>100 then
    raise exception 'invalid public page' using errcode='22023';
  end if;
  select to_jsonb(w) into workspace from public.get_public_workspace(p_workspace_slug) w;
  page_data:=jsonb_build_object('items','[]'::jsonb,'hasMore',false,'totalRows',0,'page',p_page);
  if workspace is not null and (workspace->>'public_page_enabled')::boolean then
    page_data:=public.byeollog_public_upbo_page_v1(p_workspace_slug,p_search,p_page,p_sort);
    -- Task identifiers and timestamps are sorting inputs, not public output.
    page_data:=jsonb_set(page_data,'{items}',coalesce((select jsonb_agg(item-'id'-'created_at' order by ordinal)
      from jsonb_array_elements(page_data->'items') with ordinality as x(item,ordinal)),'[]'::jsonb));
  end if;
  return jsonb_build_object('workspace',workspace,'pageData',page_data);
end $function$;


CREATE OR REPLACE FUNCTION public.byeollog_public_viewer_snapshot_v2(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text, p_view text DEFAULT 'pending'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_workspace public.byeollog_workspaces%rowtype; v_meta jsonb; v_page jsonb;
begin
  if p_page is null or p_page not between 0 and 2000 or p_sort is null or p_sort not in ('name','newest')
    or p_view is null or p_view not in ('pending','completed') or char_length(coalesce(p_search,''))>100 then
    raise exception 'invalid public page' using errcode='22023';end if;
  select * into v_workspace from public.byeollog_workspaces where slug=lower(btrim(p_workspace_slug)) and status='active' limit 1;
  v_page:=jsonb_build_object('items','[]'::jsonb,'hasMore',false,'totalRows',0,'page',p_page);
  if v_workspace.id is null then return jsonb_build_object('workspace',null,'pageData',v_page);end if;
  v_meta:=jsonb_build_object('slug',v_workspace.slug,'display_name',v_workspace.display_name,
    'public_page_enabled',coalesce(v_workspace.public_page_enabled,true),
    'public_completed_enabled',coalesce(v_workspace.public_page_enabled,true) and v_workspace.public_completed_enabled);
  if not coalesce(v_workspace.public_page_enabled,true) then return jsonb_build_object('workspace',v_meta,'pageData',v_page);end if;
  if p_view='pending' then
    v_page:=public.byeollog_public_upbo_page_v1(p_workspace_slug,p_search,p_page,p_sort);
  elsif v_workspace.public_completed_enabled then
    with base as (
      select t.id,t.fan,t.event,t.type,t.completed_at,t.done_qty as completed_qty,0 as remaining,
        coalesce(nullif(lower(btrim(t.fan_soop_id)),''),'legacy:'||coalesce(t.fan,'')) as identity,
        split_part(replace(replace(coalesce(t.public_comment,''),E'\r\n',E'\n'),E'\r',E'\n'),E'\n',1) as comment
      from public.bangsel_tasks t where t.workspace_id=v_workspace.id and t.done_qty>=t.total_qty and t.total_qty>0 and (
        nullif(btrim(p_search),'') is null or position(lower(p_search) in lower(coalesce(t.fan,'')))>0
        or position(lower(p_search) in lower(coalesce(t.fan_soop_id,'')))>0
        or exists(select 1 from public.bangsel_fans f where f.workspace_id=t.workspace_id and f.soop_id=t.fan_soop_id
          and (position(lower(p_search) in lower(coalesce(f.alias,'')))>0 or position(lower(p_search) in lower(coalesce(f.current_nickname,'')))>0)))
    ), ranked as (
      select b.*,sum(completed_qty) over(partition by identity) as fan_completed,
        row_number() over(order by case when p_sort='newest' then completed_at end desc nulls last,
          fan,identity,completed_at desc nulls last,id) as ordinal from base b
    ), page as (select * from ranked where ordinal>p_page*50 and ordinal<=p_page*50+51)
    select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'ordinal'-'id' order by ordinal) from page p where ordinal<=p_page*50+50),'[]'::jsonb),
      'hasMore',exists(select 1 from page where ordinal>p_page*50+50),'totalRows',(select count(*) from base),'page',p_page) into v_page;
  end if;
  return jsonb_build_object('workspace',v_meta,'pageData',v_page);
end $function$;


CREATE OR REPLACE FUNCTION public.get_public_bangsel(p_workspace_slug text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(fan text, event text, type text, remaining integer, comment text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with ws as (
    select w.id
    from public.byeollog_workspaces as w
    where w.slug = lower(btrim(p_workspace_slug))
      and w.status = 'active'
      and coalesce(w.public_page_enabled, true) = true
    limit 1
  ),
  q as (
    select nullif(lower(btrim(coalesce(p_search, ''))), '') as term
  )
  select
    t.fan,
    t.event,
    t.type,
    greatest(t.total_qty - t.done_qty, 0)::integer as remaining,
    btrim(
      split_part(
        replace(replace(coalesce(t.public_comment, ''), E'\r\n', E'\n'), E'\r', E'\n'),
        E'\n',
        1
      )
    ) as comment
  from public.bangsel_tasks as t
  cross join ws
  cross join q
  where t.workspace_id = ws.id
    and t.total_qty > t.done_qty
    and (
      q.term is null
      or lower(coalesce(t.fan, '')) like '%' || q.term || '%'
      or lower(coalesce(t.fan_soop_id, '')) like '%' || q.term || '%'
      or exists (
        select 1
        from public.bangsel_fans as f
        where f.workspace_id = t.workspace_id
          and f.soop_id is not null
          and f.soop_id = t.fan_soop_id
          and (
            lower(coalesce(f.alias, '')) like '%' || q.term || '%'
            or lower(coalesce(f.current_nickname, '')) like '%' || q.term || '%'
          )
      )
    )
  order by t.fan asc, t.event asc, t.type asc, t.created_at asc;
$function$;


CREATE OR REPLACE FUNCTION public.get_public_workspace(p_workspace_slug text)
 RETURNS TABLE(slug text, display_name text, public_page_enabled boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    w.slug,
    w.display_name,
    coalesce(w.public_page_enabled, true) as public_page_enabled
  from public.byeollog_workspaces as w
  where w.slug = lower(btrim(p_workspace_slug))
    and w.status = 'active'
  limit 1;
$function$;

