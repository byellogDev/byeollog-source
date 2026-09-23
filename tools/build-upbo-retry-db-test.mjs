// Produces a rollback-only test using temporary tables/functions. No customer
// rows, cron jobs or deployed functions are changed by the generated SQL.
import fs from 'node:fs';
const migration=fs.readFileSync('supabase/migrations/20260923104919_separate_upbo_review_wait.sql','utf8');
const baseline=fs.readFileSync('supabase/migrations/20260919232947_incident_retry_observability.sql','utf8');
const claim=baseline.slice(baseline.indexOf('CREATE OR REPLACE FUNCTION'),baseline.indexOf('CREATE OR REPLACE FUNCTION public.byeollog_upbo_retry_schedule_v1'));
const start=migration.indexOf('create or replace function');
const functions=(migration.slice(start,migration.indexOf('notify pgrst'))+'\n'+claim)
  .replace(/^revoke .*;\r?$/gm,'').replace(/^grant .*;\r?$/gm,'')
  .replaceAll('public.bangsel_collector_staging','pg_temp.retry_fixture')
  .replaceAll('SETOF bangsel_collector_staging','SETOF pg_temp.retry_fixture')
  .replaceAll('public.byeollog_workspaces','pg_temp.workspaces')
  .replaceAll('public.byeollog_finish_upbo_retry_v1','pg_temp.finish_retry')
  .replaceAll('public.byeollog_upbo_retry_schedule_v1','pg_temp.schedule_retry')
  .replaceAll('public.byeollog_claim_upbo_retries_v1','pg_temp.claim_retry');
const template=fs.readFileSync('tests/upbo-review-retry-db.sql','utf8');
fs.mkdirSync('.local/upbo-review-retry',{recursive:true});
fs.writeFileSync('.local/upbo-review-retry/db-test.sql',template.replace('-- INJECT FUNCTIONS',functions));
console.log('Created .local/upbo-review-retry/db-test.sql (temporary fixtures; always rollback)');
