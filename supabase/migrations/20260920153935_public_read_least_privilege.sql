-- Additive rollout: old service-role RPCs remain unchanged for the live deployment.
-- The entry point has a machine credential because donor identity inputs must not
-- become directly callable anonymous RPC output. No user session is impersonated.
set lock_timeout='2s';
do $$ begin
  if exists(select 1 from pg_roles where rolname='byeollog_public_reader') then
    raise exception 'Public reader role already exists; review before migration';
  end if;
  create role byeollog_public_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
end $$;
grant byeollog_public_reader to postgres;
create schema byeollog_public_read;
revoke all on schema byeollog_public_read from public,anon,authenticated;
grant usage on schema byeollog_public_read,public,private,extensions to byeollog_public_reader;

create table private.byeollog_public_read_keys(
  key_id text primary key,
  token_sha256 text not null unique check(token_sha256 ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table private.byeollog_public_read_config(
  singleton boolean primary key default true check(singleton),
  identity_secret bytea not null default extensions.gen_random_bytes(32)
);
insert into private.byeollog_public_read_config(singleton) values(true);
alter table private.byeollog_public_read_keys enable row level security;
alter table private.byeollog_public_read_config enable row level security;
revoke all on private.byeollog_public_read_keys,private.byeollog_public_read_config from public,anon,authenticated,service_role;
grant select on private.byeollog_public_read_keys,private.byeollog_public_read_config to byeollog_public_reader;
create policy reader_keys on private.byeollog_public_read_keys for select to byeollog_public_reader using(true);
create policy reader_identity on private.byeollog_public_read_config for select to byeollog_public_reader using(true);

-- Column grants are deliberate: new private columns cannot become readable.
grant select(id,slug,display_name,status,public_page_enabled,public_completed_enabled)
  on public.byeollog_workspaces to byeollog_public_reader;
grant select(id,workspace_id,fan,event,type,total_qty,done_qty,created_at,completed_at,fan_soop_id,public_comment)
  on public.bangsel_tasks to byeollog_public_reader;
grant select(workspace_id,soop_id,alias,current_nickname)
  on public.bangsel_fans to byeollog_public_reader;
grant select(workspace_id,public_visible,roulette_name,draft,updated_at)
  on public.byeollog_roulette_drafts to byeollog_public_reader;

create policy public_reader_workspace on public.byeollog_workspaces
  for select to byeollog_public_reader using(status='active');
create policy public_reader_pending_tasks on public.bangsel_tasks
  for select to byeollog_public_reader using(total_qty>done_qty and workspace_id in
    (select id from public.byeollog_workspaces where status='active' and coalesce(public_page_enabled,true)));
create policy public_reader_completed_tasks on public.bangsel_tasks
  for select to byeollog_public_reader using(total_qty>0 and done_qty>=total_qty and workspace_id in
    (select id from public.byeollog_workspaces where status='active' and coalesce(public_page_enabled,true) and public_completed_enabled));
create policy public_reader_fans on public.bangsel_fans
  for select to byeollog_public_reader using(workspace_id in
    (select id from public.byeollog_workspaces where status='active' and coalesce(public_page_enabled,true)));
create policy public_reader_drafts on public.byeollog_roulette_drafts
  for select to byeollog_public_reader using(public_visible and workspace_id in
    (select id from public.byeollog_workspaces where status='active' and coalesce(public_page_enabled,true)));


CREATE OR REPLACE FUNCTION byeollog_public_read.byeollog_public_upbo_page_v1(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text)
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


CREATE OR REPLACE FUNCTION byeollog_public_read.byeollog_public_viewer_snapshot_v1(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text)
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
  select to_jsonb(w) into workspace from byeollog_public_read.get_public_workspace(p_workspace_slug) w;
  page_data:=jsonb_build_object('items','[]'::jsonb,'hasMore',false,'totalRows',0,'page',p_page);
  if workspace is not null and (workspace->>'public_page_enabled')::boolean then
    page_data:=byeollog_public_read.byeollog_public_upbo_page_v1(p_workspace_slug,p_search,p_page,p_sort);
    -- Task identifiers and timestamps are sorting inputs, not public output.
    page_data:=jsonb_set(page_data,'{items}',coalesce((select jsonb_agg(item-'id'-'created_at' order by ordinal)
      from jsonb_array_elements(page_data->'items') with ordinality as x(item,ordinal)),'[]'::jsonb));
  end if;
  return jsonb_build_object('workspace',workspace,'pageData',page_data);
end $function$;


CREATE OR REPLACE FUNCTION byeollog_public_read.byeollog_public_viewer_snapshot_v2(p_workspace_slug text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 0, p_sort text DEFAULT 'name'::text, p_view text DEFAULT 'pending'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_workspace record; v_meta jsonb; v_page jsonb;
begin
  if p_page is null or p_page not between 0 and 2000 or p_sort is null or p_sort not in ('name','newest')
    or p_view is null or p_view not in ('pending','completed') or char_length(coalesce(p_search,''))>100 then
    raise exception 'invalid public page' using errcode='22023';end if;
  select id,slug,display_name,public_page_enabled,public_completed_enabled into v_workspace from public.byeollog_workspaces where slug=lower(btrim(p_workspace_slug)) and status='active' limit 1;
  v_page:=jsonb_build_object('items','[]'::jsonb,'hasMore',false,'totalRows',0,'page',p_page);
  if v_workspace.id is null then return jsonb_build_object('workspace',null,'pageData',v_page);end if;
  v_meta:=jsonb_build_object('slug',v_workspace.slug,'display_name',v_workspace.display_name,
    'public_page_enabled',coalesce(v_workspace.public_page_enabled,true),
    'public_completed_enabled',coalesce(v_workspace.public_page_enabled,true) and v_workspace.public_completed_enabled);
  if not coalesce(v_workspace.public_page_enabled,true) then return jsonb_build_object('workspace',v_meta,'pageData',v_page);end if;
  if p_view='pending' then
    v_page:=byeollog_public_read.byeollog_public_upbo_page_v1(p_workspace_slug,p_search,p_page,p_sort);
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


CREATE OR REPLACE FUNCTION byeollog_public_read.get_public_bangsel(p_workspace_slug text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(fan text, event text, type text, remaining integer, comment text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
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


CREATE OR REPLACE FUNCTION byeollog_public_read.get_public_workspace(p_workspace_slug text)
 RETURNS TABLE(slug text, display_name text, public_page_enabled boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
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


revoke all on all functions in schema byeollog_public_read from public,anon,authenticated;
grant execute on all functions in schema byeollog_public_read to byeollog_public_reader;

create function public.byeollog_public_read_v1(p_token text,p_operation text,p_args jsonb)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='5s' set lock_timeout='500ms'
as $$
declare v_slug text; v_search text; v_page integer; v_sort text; v_view text;
  v_result jsonb; v_items jsonb; v_secret bytea;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' or not exists(
    select 1 from private.byeollog_public_read_keys
    where enabled and token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex')
  ) then raise exception 'Unauthorized' using errcode='42501';end if;
  if p_operation is null or p_operation not in ('public-workspace','public-bangsel','public-upbo-page','public-viewer','public-roulette')
    or p_args is null or jsonb_typeof(p_args)<>'object' or pg_column_size(p_args)>4096 then
    raise exception 'Invalid public request' using errcode='22023';end if;
  if exists(select 1 from jsonb_object_keys(p_args) k where k not in ('p_workspace_slug','p_search','p_page','p_sort','p_view')) then
    raise exception 'Invalid public request' using errcode='22023';end if;
  v_slug:=lower(btrim(p_args->>'p_workspace_slug'));
  v_search:=nullif(btrim(p_args->>'p_search'),'');
  v_page:=coalesce((p_args->>'p_page')::integer,0);
  v_sort:=coalesce(p_args->>'p_sort','name');
  v_view:=p_args->>'p_view';
  if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9_-]{1,62}$' or length(coalesce(v_search,''))>100
    or v_page not between 0 and 2000 or v_sort not in ('name','remaining','newest')
    or (v_view is not null and v_view not in ('pending','completed')) then
    raise exception 'Invalid public request' using errcode='22023';end if;

  case p_operation
  when 'public-workspace' then
    select coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) into v_result
      from byeollog_public_read.get_public_workspace(v_slug) w;
  when 'public-bangsel' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into v_result
      from byeollog_public_read.get_public_bangsel(v_slug,v_search) t;
  when 'public-upbo-page' then
    v_result:=byeollog_public_read.byeollog_public_upbo_page_v1(v_slug,v_search,v_page,v_sort);
  when 'public-viewer' then
    if v_view is null then
      v_result:=byeollog_public_read.byeollog_public_viewer_snapshot_v1(v_slug,v_search,v_page,v_sort);
    else
      v_result:=byeollog_public_read.byeollog_public_viewer_snapshot_v2(v_slug,v_search,v_page,v_sort,v_view);
    end if;
  when 'public-roulette' then
    select coalesce(jsonb_agg(jsonb_build_object('roulette_name',r.roulette_name,
      'draft',jsonb_build_object('balloonsPerSpin',r.draft->'balloonsPerSpin','items',
        coalesce((select jsonb_agg(jsonb_build_object('resultText',i->'resultText','probabilityPpm',i->'probabilityPpm') order by n)
          from jsonb_array_elements(case when jsonb_typeof(r.draft->'items')='array' then r.draft->'items' else '[]'::jsonb end)
          with ordinality x(i,n)),'[]'::jsonb)),
      'updated_at',r.updated_at) order by r.updated_at desc),'[]'::jsonb) into v_result
    from (select d.roulette_name,d.draft,d.updated_at from public.byeollog_roulette_drafts d
      join public.byeollog_workspaces w on w.id=d.workspace_id
      where w.slug=v_slug and w.status='active' and w.public_page_enabled=true and d.public_visible=true
      order by d.updated_at desc limit 100) r;
  end case;

  if p_operation in ('public-upbo-page','public-viewer') then
    select identity_secret into strict v_secret from private.byeollog_public_read_config where singleton;
    v_items:=case when p_operation='public-viewer' then v_result#>'{pageData,items}' else v_result->'items' end;
    select coalesce(jsonb_agg((item-'identity'-'id'-'created_at')||jsonb_build_object('fan_key',
      encode(extensions.hmac(convert_to(jsonb_build_array(v_slug,item->>'identity')::text,'UTF8'),v_secret,'sha256'),'hex')) order by n),'[]'::jsonb)
      into v_items from jsonb_array_elements(v_items) with ordinality x(item,n);
    v_result:=jsonb_set(v_result,case when p_operation='public-viewer' then array['pageData','items'] else array['items'] end,v_items);
  end if;
  return v_result;
end $$;

-- Only the audited entry point switches role, never a login or table API.
revoke all on function public.byeollog_public_read_v1(text,text,jsonb) from public,anon,authenticated,service_role;
grant create on schema public to byeollog_public_reader;
alter function public.byeollog_public_read_v1(text,text,jsonb) owner to byeollog_public_reader;
revoke create on schema public from byeollog_public_reader;
grant execute on function public.byeollog_public_read_v1(text,text,jsonb) to anon;
comment on function public.byeollog_public_read_v1(text,text,jsonb) is
  'Machine-token protected public read gateway; NOLOGIN/NOBYPASSRLS owner, column SELECT only, fixed operations, no raw donor IDs.';
notify pgrst,'reload schema';


