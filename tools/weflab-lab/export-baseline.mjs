import fs from 'node:fs';
// Run locally with an existing read-only approved credential source. Never copy it to the observer.
export async function exportBaseline(config, from, to, base, key, output) {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from >= to) throw Error('invalid_window');
  if (!base || !key) throw Error('missing_read_credential');
  const read = async (table, select) => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const q = new URLSearchParams({ select, workspace_id: 'eq.' + config.workspaceId, and: `(occurred_at.gte.${from},occurred_at.lt.${to})`, order:'occurred_at.asc,id.asc', limit:'500', offset:String(offset) });
      const r = await fetch(new URL('/rest/v1/' + table + '?' + q, base), { headers:{apikey:key,Authorization:'Bearer '+key}, signal:AbortSignal.timeout(20000) });
      if (!r.ok) throw Error('baseline_http_'+r.status);
      const batch = await r.json(); rows.push(...batch);
      if (batch.length < 500) return rows;
      if (rows.length >= 100000) throw Error('baseline_capacity_no_partial_success');
    }
  };
  const donations = await read('byeollog_soop_core_donations','id,workspace_id,actor_id,amount,donation_type_label,occurred_at,created_at,result_count,last_result_at,expected_spins,status,source_bj_id,roulette_enabled');
  const results = await read('byeollog_soop_core_roulette_results','id,workspace_id,donation_id,result_text,roulette_name,occurred_at,created_at,match_state,source_bj_id');
  const receipt = { at:new Date().toISOString(),owner:config.owner,workspaceId:config.workspaceId,from,to,complete:true,donations,results,limits:'Export after the comparison window has closed; later DB arrivals require a new export.' };
  fs.writeFileSync(output,JSON.stringify(receipt),{mode:0o600});
  return { donations:donations.length,results:results.length,complete:true };
}
