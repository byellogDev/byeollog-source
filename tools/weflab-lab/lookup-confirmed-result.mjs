import fs from 'node:fs';
import path from 'node:path';
import { hash, loadContext, loadRules, compareDonations, classifyResult } from './protocol.mjs';
// Explicit operator action only. This endpoint can CREATE results; never run from the observer.
const [cfgFile, evidenceDir, baselineFile, uid, receiptFile, approval] = process.argv.slice(2);
if (approval !== '--confirmed-result') throw Error('requires_confirmed_result_review');
const cfg = JSON.parse(fs.readFileSync(cfgFile));
const baseline = JSON.parse(fs.readFileSync(baselineFile));
const rows = fs.readdirSync(evidenceDir).filter(f=>/^evidence-.*\.jsonl$/.test(f)).sort().flatMap(f=>fs.readFileSync(path.join(evidenceDir,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)).sort((a,b)=>a.at.localeCompare(b.at));
const events = rows.filter(r=>r.kind==='normalized' && r.event.kind==='donation').map(r=>r.event).filter(e=>e.receivedAt>=baseline.from && e.receivedAt<baseline.to);
const comparison = compareDonations(events,baseline,cfg);
if (comparison.conflicts.length) throw Error('candidate_conflict');
const pair = comparison.matched.find(p=>p.uid===uid), event = events.find(e=>e.uid===uid);
if (!pair || !event) throw Error('no_unique_correspondence');
const donation = baseline.donations.find(d=>d.id===pair.donationId);
const results = baseline.results.filter(r=>r.donation_id===donation.id);
if (!results.length || results.some(r=>r.workspace_id!==cfg.workspaceId || (r.source_bj_id && r.source_bj_id!==cfg.owner))) throw Error('missing_or_wrong_account_result');
if (Date.now()-Date.parse(donation.last_result_at)<60000 || !Number.isFinite(Date.parse(donation.last_result_at))) throw Error('result_not_stable');
const snapshot = rows.filter(r=>r.kind==='rules' && r.at<=event.receivedAt).at(-1);
if (!snapshot) throw Error('no_event_rule_snapshot');
const c = await loadContext(cfg), current = await loadRules(c);
if (hash(current)!==snapshot.hash) throw Error('rules_changed_no_lookup');
if (current.data?.checkbox?.item_alert_rouletteuse!=='on') throw Error('roulette_disabled');
// Only an unambiguous exact-amount rule is supported in this first checkpoint.
const rules = (current.data?.donation?.item_roulette_donation||[]).filter(r=>r.checkbox?.setup_roulette_use==='on' && Number(r.text?.setup_alert_giftmin)<=event.amount && Number(r.text?.setup_alert_giftmax)>=event.amount);
if (rules.length!==1) throw Error('ambiguous_rule');
const rule=rules[0];
if (Number(rule.text.setup_alert_giftmin)!==event.amount || Number(rule.text.setup_alert_giftmax)!==event.amount || rule.checkbox.setup_roulette_range==='on') throw Error('unsupported_range_rule');
const count=rule.checkbox.setup_roulette_double==='on'?Number(rule.select?.setup_roulette_doublecount):1;
if (!Number.isSafeInteger(count)||count<1||count>100 || results.length!==count || Number(donation.result_count)!==count || Number(donation.expected_spins)!==count) throw Error('incomplete_result_count');
const roulette={};
for (const item of rule.roulette?.setup_roulette||[]) if(item.name!==''&&item.percent!=='') roulette[item.name.trim()]=item.percent;
if (Object.keys(roulette).length<2) throw Error('unsupported_roulette');
// Exclusive receipt makes uncertain network outcomes non-retryable.
fs.writeFileSync(receiptFile,JSON.stringify({at:new Date().toISOString(),status:'request_started',uid,donationId:donation.id}),{flag:'wx',mode:0o600});
try {
  const response=await fetch('https://weflab.com/api/',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({type:'roulette_result',pagetype:c.type,idx:String(c.idx),platform:'afreeca',id:cfg.owner,uid,value:String(event.amount),count:String(count),roulette:JSON.stringify(roulette)})});
  const raw=await response.text(); let data; try{data=JSON.parse(raw);}catch{}
  const assessment=classifyResult(data);
  const expected=results.sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.created_at.localeCompare(b.created_at)).map(r=>r.result_text);
  const equal=assessment.status==='stored_result_observed' && JSON.stringify(assessment.results)===JSON.stringify(expected);
  const receipt={at:new Date().toISOString(),uid,donationId:donation.id,httpStatus:response.status,raw,assessment,expected,equal,status:!response.ok||assessment.status==='needs_review'?'needs_review':equal?'result_match':'result_difference_requires_review'};
  fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify({status:receipt.status,api:data?.api,equal}));
} catch { fs.writeFileSync(receiptFile,JSON.stringify({status:'needs_review',reason:'uncertain_request_do_not_repeat',uid})); throw Error('uncertain_request_do_not_repeat'); }
