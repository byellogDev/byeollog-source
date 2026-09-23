begin;
set local lock_timeout='3s';
alter table public.byeollog_workspaces add column public_completed_enabled boolean not null default false;
alter table public.bangsel_tasks add column completed_at timestamptz;
-- Historical updated_at can mean a memo edit. Never invent a completion time.
create or replace function public.byeollog_track_task_completion_v1()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.done_qty>=new.total_qty and new.total_qty>0 then
    -- Backup restore explicitly supplies the saved completion timestamp.
    -- Normal task writes omit this server-owned field.
    if new.completed_at is distinct from old.completed_at then null;
    elsif old.done_qty<old.total_qty then new.completed_at:=clock_timestamp();
    else new.completed_at:=old.completed_at;end if;
  else new.completed_at:=null;end if;
  return new;
end $$;
revoke all on function public.byeollog_track_task_completion_v1() from public,anon,authenticated,service_role;
create trigger track_task_completion before update on public.bangsel_tasks for each row execute function public.byeollog_track_task_completion_v1();
create index byeollog_completed_task_order on public.bangsel_tasks(workspace_id,completed_at desc,id) where done_qty>=total_qty and total_qty>0;

create or replace function public.byeollog_public_viewer_snapshot_v2(
  p_workspace_slug text,p_search text default null,p_page integer default 0,p_sort text default 'name',p_view text default 'pending')
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
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
end $$;
revoke all on function public.byeollog_public_viewer_snapshot_v2(text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.byeollog_public_viewer_snapshot_v2(text,text,integer,text,text) to service_role;
commit;


