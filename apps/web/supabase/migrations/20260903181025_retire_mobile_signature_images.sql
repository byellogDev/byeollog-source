-- The wallpaper-only product accepts one signature source image. Existing PC
-- originals and generated wallpaper derivatives remain; mobile references are
-- retired and their objects are removed through the Storage API during rollout.

alter table public.byeollog_signature_balloons
  drop constraint if exists byeollog_signature_balloons_mobile_image_check;

-- Older production installs received an unnamed inline CHECK constraint from
-- the original CREATE TABLE statement. PostgreSQL generated the `check1`
-- name, so retire that compatibility constraint as well before nulling rows.
alter table public.byeollog_signature_balloons
  drop constraint if exists byeollog_signature_balloons_check1;

alter table public.byeollog_signature_balloons
  alter column mobile_image drop not null;

update public.byeollog_signature_balloons
set mobile_image=null,
    updated_at=clock_timestamp()
where mobile_image is not null;

comment on column public.byeollog_signature_balloons.mobile_image is
  'Retired compatibility column. New and migrated signature registrations keep only the PC source and the server-generated wallpaper derivative.';
