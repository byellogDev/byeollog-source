-- Donations begin at one balloon, so an omitted lower endpoint means one.

alter table public.byeollog_default_donation_images
  drop constraint if exists byeollog_default_donation_images_min_amount_check;

update public.byeollog_default_donation_images
set min_amount=1,updated_at=clock_timestamp()
where min_amount=0;

alter table public.byeollog_default_donation_images
  alter column min_amount set default 1,
  add constraint byeollog_default_donation_images_min_amount_check
    check (min_amount between 1 and 2147483647);

comment on column public.byeollog_default_donation_images.min_amount is
  'Inclusive lower bound. UI blank is normalized to one.';
