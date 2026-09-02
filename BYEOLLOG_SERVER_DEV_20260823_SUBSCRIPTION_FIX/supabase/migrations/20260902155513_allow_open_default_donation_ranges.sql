-- Range endpoints are optional in the UI:
-- missing minimum means zero and missing maximum means no upper bound.

alter table public.byeollog_default_donation_images
  drop constraint if exists byeollog_default_donation_images_min_amount_check,
  drop constraint if exists byeollog_default_donation_images_max_amount_check;

alter table public.byeollog_default_donation_images
  alter column min_amount set default 0,
  alter column max_amount drop not null;

alter table public.byeollog_default_donation_images
  add constraint byeollog_default_donation_images_min_amount_check
    check (min_amount between 0 and 2147483647),
  add constraint byeollog_default_donation_images_max_amount_check
    check (max_amount is null or max_amount between min_amount and 2147483647);

comment on column public.byeollog_default_donation_images.min_amount is
  'Inclusive lower bound. UI blank is normalized to zero.';
comment on column public.byeollog_default_donation_images.max_amount is
  'Inclusive upper bound. NULL means no upper limit.';

create or replace function byeollog_automation.guard_default_donation_image_range_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text,9137421));
  if exists (
    select 1
    from public.byeollog_default_donation_images existing
    where existing.workspace_id=new.workspace_id
      and existing.id<>new.id
      and int8range(
        existing.min_amount::bigint,
        case when existing.max_amount is null then null else existing.max_amount::bigint+1 end,
        '[)'
      ) && int8range(
        new.min_amount::bigint,
        case when new.max_amount is null then null else new.max_amount::bigint+1 end,
        '[)'
      )
  ) then
    raise exception 'default donation image ranges overlap' using errcode='23P01';
  end if;
  return new;
end
$function$;
