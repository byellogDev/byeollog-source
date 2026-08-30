-- The current public Agent uses save_guided_rule_v11 and
-- get_raffle_state_v2. Older public releases were never distributed, so
-- keeping superseded mutable facades executable only enlarges the API surface.
-- The functions remain installed for schema history; direct clients lose use.
revoke execute on function public.save_guided_rule_v8(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,uuid,integer)
  from public,anon,authenticated,service_role;

revoke execute on function public.save_guided_rule_v9(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,uuid,integer)
  from public,anon,authenticated,service_role;

revoke execute on function public.save_guided_rule_v10(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,
  integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;

revoke execute on function public.get_raffle_state_v1(uuid)
  from public,anon,authenticated,service_role;

;
