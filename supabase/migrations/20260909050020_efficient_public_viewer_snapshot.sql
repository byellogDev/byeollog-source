-- Additive endpoint: old viewer tabs keep their existing RPCs. Every request
-- checks current publication state; no retained response cache or new quota.
create or replace function public.byeollog_public_viewer_snapshot_v1(
  p_workspace_slug text,p_search text default null,p_page integer default 0,p_sort text default 'name')
returns jsonb language plpgsql stable security invoker
set search_path='' set statement_timeout='5s'
as $$
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
end $$;
revoke all on function public.byeollog_public_viewer_snapshot_v1(text,text,integer,text) from public,anon,authenticated;
grant execute on function public.byeollog_public_viewer_snapshot_v1(text,text,integer,text) to service_role;


