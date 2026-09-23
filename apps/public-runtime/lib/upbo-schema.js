import {supabaseConfig} from './supabase-rest.js';

export function assertUpboSchema(schema){
  if(!schema?.definitions?.byeollog_roulette_amount_mappings?.properties?.enabled||!schema?.definitions?.byeollog_soop_core_donations?.properties?.roulette_enabled){
    throw new Error('Required DB activation migration is missing. Production promotion is blocked.');
  }
  for(const name of ['byeollog_commit_upbo_group_v1','byeollog_claim_upbo_retries_v1',
    'byeollog_export_backup_v8','byeollog_restore_backup_v2']){
    if(!schema?.paths?.[`/rpc/${name}`]?.post)throw new Error(`Required DB migration is missing: ${name}. Production promotion is blocked.`);
  }
  const columns=schema?.definitions?.bangsel_collector_staging?.properties;
  for(const name of ['upbo_retry_protocol','upbo_retry_attempts','upbo_retry_after']){
    if(!columns?.[name])throw new Error(`Required DB retry column is missing: ${name}. Production promotion is blocked.`);
  }
  const rules=schema?.definitions?.byeollog_special_roulette_rules?.properties;
  for(const name of ['workspace_id','result_text','enabled','allow_stacking']){
    if(!rules?.[name])throw new Error(`Required DB special roulette column is missing: ${name}. Production promotion is blocked.`);
  }
  if(!schema?.definitions?.byeollog_soop_core_roulette_results?.properties?.special_roulette){
    throw new Error('Required DB special roulette decision column is missing. Production promotion is blocked.');
  }
  for(const [table,column] of [['byeollog_roulette_amount_mappings','balloons_max'],['byeollog_workspaces','public_completed_enabled'],['bangsel_tasks','completed_at']]){
    if(!schema?.definitions?.[table]?.properties?.[column])throw new Error(`Required DB UX column is missing: ${table}.${column}. Production promotion is blocked.`);
  }
  for(const name of ['byeollog_save_roulette_ranges_v1','byeollog_public_viewer_snapshot_v2','byeollog_dashboard_counts_v1','byeollog_submit_support_request_v1']){
    if(!schema?.paths?.[`/rpc/${name}`]?.post)throw new Error(`Required DB UX migration is missing: ${name}. Production promotion is blocked.`);
  }
}
export async function checkUpboSchema({config=supabaseConfig(),fetchImpl=fetch}={}){
  if(config.url!=='https://offslvwaugvjotkywlus.supabase.co')throw new Error('Production DB identity mismatch; schema gate stopped.');
  const response=await fetchImpl(config.url+'/rest/v1/',{
    headers:{apikey:config.apikey,Authorization:'Bearer '+config.serviceRoleKey,Accept:'application/openapi+json'},
    signal:AbortSignal.timeout(15000),cache:'no-store'
  });
  if(!response.ok)throw new Error(`Read-only DB schema check failed (${response.status}).`);
  assertUpboSchema(await response.json());
}
