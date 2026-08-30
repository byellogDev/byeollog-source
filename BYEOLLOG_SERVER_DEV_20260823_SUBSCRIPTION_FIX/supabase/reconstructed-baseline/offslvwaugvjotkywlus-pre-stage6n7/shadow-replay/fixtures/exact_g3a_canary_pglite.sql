-- SHADOW/PGLITE FIXTURE ONLY. NEVER APPLY TO PRODUCTION.
insert into auth.users(id,email)
values ('37c0485c-2848-5a49-a35c-9aca5b3c459b','shadow-canary@invalid.example');

insert into public.byeollog_workspaces(id,slug,display_name,owner_user_id,status)
values (
  '24adec81-8833-5c68-80fe-2d26eae075fb',
  'shadow-canary',
  'Shadow Canary',
  '37c0485c-2848-5a49-a35c-9aca5b3c459b',
  'active'
);

insert into public.byeollog_workspace_members(workspace_id,user_id,role)
values (
  '24adec81-8833-5c68-80fe-2d26eae075fb',
  '37c0485c-2848-5a49-a35c-9aca5b3c459b',
  'owner'
);
