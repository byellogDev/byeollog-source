begin;
set local lock_timeout='3s';
create table private.stream_start_notices_v1(workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,broadcast_instance_id uuid not null);
alter table private.stream_start_notices_v1 enable row level security;
revoke all on private.stream_start_notices_v1 from public,anon,authenticated,service_role;
-- Do not announce already-running broadcasts as newly started at deployment.
insert into private.stream_start_notices_v1 select workspace_id,broadcast_instance_id from public.byeollog_soop_gateway_sessions where broadcast_instance_id is not null;
create function private.notify_stream_collection_started_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare v_name text; v_changed uuid;
begin
  if new.state<>'connected' or new.broadcast_instance_id is null or new.chat_number is null then return new;end if;
  select left(display_name,120) into v_name from public.byeollog_workspaces where id=new.workspace_id and status='active';
  if not found then return new;end if;
  insert into private.stream_start_notices_v1 values(new.workspace_id,new.broadcast_instance_id)
    on conflict(workspace_id) do update set broadcast_instance_id=excluded.broadcast_instance_id
    where stream_start_notices_v1.broadcast_instance_id is distinct from excluded.broadcast_instance_id returning workspace_id into v_changed;
  if v_changed is not null then
    insert into private.ops_alert_delivery_v1(source_key,topic,message) values('stream-start:'||new.broadcast_instance_id,'stream-start:'||new.workspace_id,
      '[별록 수집 시작] '||coalesce(nullif(v_name,''),'스트리머')||'님의 방송에 연결되어 후원 수집을 시작했습니다. · '||to_char(clock_timestamp() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')||' (한국 시간)') on conflict(source_key) do nothing;
  end if;
  return new;
exception when others then return new; -- Optional notifications must never interrupt collection.
end $$;
revoke all on function private.notify_stream_collection_started_v1() from public,anon,authenticated,service_role;
create trigger notify_stream_collection_started after insert or update on public.byeollog_soop_gateway_sessions for each row execute function private.notify_stream_collection_started_v1();

create function public.byeollog_submit_support_request_v1(p_workspace_id uuid,p_user_id uuid,p_request_id uuid,p_message text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s' as $$
declare v_name text; v_id bigint; v_topic text:='beta-support:'||p_workspace_id;
begin
  select left(w.display_name,120) into v_name from public.byeollog_workspaces w join public.byeollog_workspace_members m on m.workspace_id=w.id
    where w.id=p_workspace_id and w.status='active' and m.user_id=p_user_id and lower(m.role::text) in ('owner','editor','manager');
  if not found then raise exception 'unauthorized' using errcode='42501';end if;
  if p_request_id is null or p_message is null or char_length(btrim(p_message)) not between 5 and 1000 then raise exception 'invalid request' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_topic,0));
  select id into v_id from private.ops_alert_delivery_v1 where source_key='support:'||p_workspace_id||':'||p_request_id;
  if found then return jsonb_build_object('ok',true,'duplicate',true);end if;
  if exists(select 1 from private.ops_alert_delivery_v1 where topic=v_topic and created_at>clock_timestamp()-interval '1 minute')
    or (select count(*) from private.ops_alert_delivery_v1 where topic=v_topic and created_at>clock_timestamp()-interval '15 minutes')>=5 then
    raise exception 'support rate limit' using errcode='PT429';end if;
  insert into private.ops_alert_delivery_v1(source_key,topic,message) values('support:'||p_workspace_id||':'||p_request_id,v_topic,
    '[별록 긴급 호출 · 무료 베타]'||E'\n스트리머: '||coalesce(nullif(v_name,''),'이름 없음')||E'\n내용: '||btrim(p_message)||E'\n접수: '||to_char(clock_timestamp() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS')||' (한국 시간)');
  return jsonb_build_object('ok',true,'duplicate',false);
end $$;
revoke all on function public.byeollog_submit_support_request_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.byeollog_submit_support_request_v1(uuid,uuid,uuid,text) to service_role;
commit;


