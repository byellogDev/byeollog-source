begin;

-- Older approved workspaces may predate the canonical owner_user_id and
-- soop_id columns. Backfill only when the existing membership and approved
-- signup record identify one unambiguous owner and one conflict-free SOOP ID.
with owner_stats as (
  select
    workspace_id,
    count(*) filter (where role='owner')::int as owner_count,
    (min(user_id::text) filter (where role='owner'))::uuid as owner_user_id
  from public.byeollog_workspace_members
  group by workspace_id
),
approved_apps as (
  select
    workspace_id,
    count(*)::int as app_count,
    (min(auth_user_id::text))::uuid as auth_user_id,
    min(lower(btrim(soop_id))) as soop_id
  from public.byeollog_signup_applications
  where status='approved'
  group by workspace_id
),
safe_candidates as (
  select
    w.id,
    os.owner_user_id,
    case
      when nullif(btrim(w.soop_id),'') is not null then lower(btrim(w.soop_id))
      else aa.soop_id
    end as soop_id
  from public.byeollog_workspaces w
  join owner_stats os on os.workspace_id=w.id
  left join approved_apps aa on aa.workspace_id=w.id
  where (w.owner_user_id is null or nullif(btrim(w.soop_id),'') is null)
    and os.owner_count=1
    and os.owner_user_id is not null
    and (
      nullif(btrim(w.soop_id),'') is not null
      or (
        aa.app_count=1
        and aa.auth_user_id=os.owner_user_id
        and aa.soop_id~'^[a-z0-9_.-]{2,80}$'
        and not exists (
          select 1
          from public.byeollog_workspaces other
          where other.id<>w.id
            and lower(btrim(other.soop_id))=aa.soop_id
        )
      )
    )
)
update public.byeollog_workspaces w
set owner_user_id=c.owner_user_id,
    soop_id=c.soop_id,
    updated_at=clock_timestamp()
from safe_candidates c
where w.id=c.id
  and (w.owner_user_id is distinct from c.owner_user_id
       or lower(btrim(w.soop_id)) is distinct from c.soop_id);

commit;
