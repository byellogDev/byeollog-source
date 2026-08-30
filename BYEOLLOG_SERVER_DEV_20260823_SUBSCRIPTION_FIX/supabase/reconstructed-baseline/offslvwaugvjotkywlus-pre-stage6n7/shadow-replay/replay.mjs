import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const replayDir = path.dirname(fileURLToPath(import.meta.url))
const baselineDir = path.dirname(replayDir)
const supabaseDir = path.resolve(baselineDir, '..', '..')
const referenceDir = path.join(
  supabaseDir,
  'reference-migrations',
  'offslvwaugvjotkywlus-20260830',
  'migrations',
)
const strictReferenceOnly = process.argv.includes('--strict-reference-only')
const verboseSignatures = process.argv.includes('--verbose-signatures')

const bootstrap = path.join(baselineDir, 'reconstructed_pre_stage6n7_bootstrap.sql')
const migrations = (await fs.readdir(referenceDir))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => path.join(referenceDir, name))
const files = [bootstrap, ...migrations]

if (migrations.length !== 79) {
  throw new Error(`Expected 79 reference migrations, found ${migrations.length}`)
}

const db = await PGlite.create({ extensions: { pgcrypto } })

const prelude = String.raw`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;
create schema vault;
create schema net;
create schema cron;

create extension pgcrypto with schema extensions;

create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  not_after timestamptz
);

create function auth.uid() returns uuid
language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb
language sql stable as $$ select '{}'::jsonb $$;
create function auth.role() returns text
language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;

create table vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text
);

-- PGlite compatibility objects. These validate migration dependencies, not the
-- real pg_cron/pg_net extension behavior.
create table cron.job (
  jobid bigint generated always as identity primary key,
  jobname text unique
);
create function cron.unschedule(bigint) returns boolean
language sql as $$ select true $$;
create function cron.schedule(text,text,text) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job(jobname) values ($1)
  on conflict (jobname) do update set jobname=excluded.jobname
  returning jobid into v_id;
  return v_id;
end
$$;

create function net.http_post(
  url text,
  body jsonb default null,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 1000
) returns bigint language sql as $$ select 1::bigint $$;
`

await db.exec(prelude)

const readSql = async (file) => fs.readFile(file, 'utf8')
const applyTransition = async (file) => {
  await db.exec(await readSql(file))
  process.stdout.write(`TRANSITION ${path.basename(file)} applied\n`)
}

let applied = 0
for (const file of files) {
  const name = path.basename(file)

  if (!strictReferenceOnly && name === '20260819165539_offsl_g3a_rc2_compat_surface.sql') {
    const fixture = path.join(replayDir, 'fixtures', 'exact_g3a_canary_pglite.sql')
    await db.exec(await readSql(fixture))
    process.stdout.write(`FIXTURE ${path.basename(fixture)} applied\n`)
  }

  if (!strictReferenceOnly && name === '20260819175814_offsl_g3a_public_release_surface.sql') {
    await applyTransition(
      path.join(replayDir, 'transitions', '20260819175000_drop_g3a_install_dormant.sql'),
    )
  }

  if (!strictReferenceOnly && name === '20260825142054_add_voice_anonymizer_pitch_presets.sql') {
    await applyTransition(
      path.join(supabaseDir, 'dormant-migrations', '20260825110000_native_roulette_sdk_skeleton.sql'),
    )
  }

  if (!strictReferenceOnly && name === '20260828220044_promote_native_roulette_production_runtime.sql') {
    const localGaps = [
      path.join(supabaseDir, 'dormant-migrations', '20260828160441_add_soop_oauth_connections.sql'),
      path.join(supabaseDir, 'migrations', '20260828173951_soop_gateway_readiness_observability.sql'),
      path.join(referenceDir, '20260829030000_add_ephemeral_soop_roulette_overlay_experiment.sql'),
    ]
    for (const localGap of localGaps) await applyTransition(localGap)
  }

  if (!strictReferenceOnly && name === '20260829211652_rebuild_common_overlay_delivery_v8.sql') {
    const localGaps = [
      '20260829193604_add_live_roulette_followup_card.sql',
      '20260829200648_keep_followup_chat_open_during_series.sql',
    ]
    for (const localName of localGaps) {
      await applyTransition(path.join(supabaseDir, 'migrations', localName))
    }
  }

  let sql = await readSql(file)
  sql = sql
    .replace(
      /^create extension if not exists pg_cron;\s*$/gim,
      '-- PGlite shim: pg_cron objects supplied by prelude',
    )
    .replace(
      /^create extension if not exists pg_net with schema extensions;\s*$/gim,
      '-- PGlite shim: pg_net objects supplied by prelude',
    )

  try {
    await db.exec(sql)
    applied += 1
    process.stdout.write(`PASS ${String(applied).padStart(2, '0')}/${files.length} ${name}\n`)
  } catch (error) {
    process.stderr.write(`FAIL ${String(applied + 1).padStart(2, '0')}/${files.length} ${name}\n`)
    process.stderr.write(`${error?.message ?? error}\n`)
    await db.close()
    process.exit(1)
  }
}

const catalogFingerprintSql = String.raw`
with
tables as (
  select n.nspname||'.'||c.relname||'|'||c.relkind::text||'|'||c.relrowsecurity::text as value
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','byeollog_automation') and c.relkind in ('r','p')
),
columns as (
  select n.nspname||'.'||c.relname||'.'||a.attname||'|'||
    format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text||'|'||
    coalesce(pg_get_expr(d.adbin,d.adrelid),'') as value
  from pg_attribute a
  join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname in ('public','byeollog_automation') and c.relkind in ('r','p')
    and a.attnum>0 and not a.attisdropped
),
functions as (
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||
    pg_get_function_result(p.oid)||'|'||p.prosecdef::text||'|'||p.provolatile::text||'|'||
    coalesce(array_to_string(p.proconfig,','),'') as value
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','byeollog_automation')
    and not (n.nspname='public' and p.proname='rls_auto_enable')
),
policies as (
  select n.nspname||'.'||c.relname||'.'||p.polname||'|'||p.polcmd::text||'|'||
    p.polpermissive::text||'|'||coalesce(pg_get_expr(p.polqual,p.polrelid),'')||'|'||
    coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') as value
  from pg_policy p
  join pg_class c on c.oid=p.polrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','byeollog_automation')
),
indexes as (
  select schemaname||'.'||indexname||'|'||indexdef as value
  from pg_indexes where schemaname in ('public','byeollog_automation')
),
triggers as (
  select n.nspname||'.'||c.relname||'.'||t.tgname||'|'||pg_get_triggerdef(t.oid,true) as value
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','byeollog_automation') and not t.tgisinternal
)
select 'tables' as component,count(*)::int as count,md5(coalesce(string_agg(value,E'\n' order by value),'')) as fingerprint from tables
union all select 'columns',count(*)::int,md5(coalesce(string_agg(value,E'\n' order by value),'')) from columns
union all select 'functions',count(*)::int,md5(coalesce(string_agg(value,E'\n' order by value),'')) from functions
union all select 'policies',count(*)::int,md5(coalesce(string_agg(value,E'\n' order by value),'')) from policies
union all select 'indexes',count(*)::int,md5(coalesce(string_agg(value,E'\n' order by value),'')) from indexes
union all select 'triggers',count(*)::int,md5(coalesce(string_agg(value,E'\n' order by value),'')) from triggers
order by component
`

const fingerprint = await db.query(catalogFingerprintSql)
const functionSignatures = await db.query(`
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as signature
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','byeollog_automation')
    and not (n.nspname='public' and p.proname='rls_auto_enable')
  order by signature
`)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  mode: strictReferenceOnly ? 'strict-reference-only' : 'resolved-history',
  engine: 'PGlite 0.5.8',
  applied,
  total: files.length,
  comparableCatalog: fingerprint.rows,
  functionCount: functionSignatures.rows.length,
  ...(verboseSignatures
    ? { functionSignatures: functionSignatures.rows.map((row) => row.signature) }
    : {}),
})}\n`)

await db.close()
