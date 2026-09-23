-- The original table used unnamed checks. Later migrations introduced named,
-- nullable/open-range replacements but could not remove these generated names.
-- Keep the current explicit checks and remove only the two superseded checks.

alter table public.byeollog_default_donation_images
  drop constraint if exists byeollog_default_donation_images_check,
  drop constraint if exists byeollog_default_donation_images_check2;
