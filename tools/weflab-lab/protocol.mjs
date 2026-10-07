import crypto from 'node:crypto';

export const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateContext(c, pin) {
  if (c?.type !== 'page' || c.pageid !== 'alert' ||
      String(c.idx) !== String(pin.idx) || String(c.preset) !== String(pin.preset) ||
      c.platform?.afreeca?.id !== pin.owner ||
      c.config?.url?.socket !== 'https://ssmain.weflab.com' ||
      c.config?.url?.socket_afreeca !== 'https://ssafreeca.weflab.com') throw Error('context_identity_mismatch');
  return c;
}
export async function loadContext(config) {
  const url = new URL(config.url);
  if (url.origin !== 'https://weflab.com' || !/^\/page\/[A-Za-z0-9]+$/.test(url.pathname) || url.search || url.hash) throw Error('invalid_overlay_url');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error('context_http_' + r.status);
  const match = (await r.text()).match(/const loginData\s*=\s*(\{[^\r\n]*\});/);
  if (!match) throw Error('context_missing');
  return validateContext(JSON.parse(match[1]), config);
}
export async function loadRules(c) {
  const r = await fetch('https://weflab.com/api/', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ type: 'page_load', pagetype: c.type, idx: String(c.idx), pageid: c.pageid, preset: String(c.preset), dir: c.dir, ver: c.config.ver })
  });
  if (!r.ok) throw Error('rules_http_' + r.status);
  const data = await r.json();
  if (data.result !== 'success') throw Error('rules_load_failed');
  return data;
}
export function joinMessage(c, channel) {
  const common = { page: c.type, idx: c.idx, pageid: c.pageid, preset: c.preset };
  return channel === 'main' ? { type: 'join', ...common } : { type: 'join_platform', platform: 'afreeca', id: c.platform.afreeca.id, ...common };
}
export function normalize(event, pin, receivedAt) {
  if (!Array.isArray(event) || event[0] !== 'msg' || !event[1] || typeof event[1] !== 'object') return { kind: 'unknown' };
  const m = event[1];
  if (m.idx != null && String(m.idx) !== String(pin.idx)) throw Error('account_mismatch');
  if (m.preset != null && String(m.preset) !== String(pin.preset)) return { kind: 'other_preset' };
  if (m.type === 'test_donation' || m.type === 'alert_replay' || m.data?.test || m.data?.replay) return { kind: 'test_or_replay' };
  if (m.type !== 'alert') return { kind: 'control', type: m.type };
  if (m.platform !== 'afreeca' || m.id !== pin.owner) throw Error('account_mismatch');
  const d = m.data;
  if (!d || d.subtype !== 'SENDBALLOON') return { kind: 'unsupported_donation', subtype: d?.subtype };
  if (!d.uid || !d.id || !Number.isSafeInteger(Number(d.value)) || Number(d.value) <= 0) throw Error('donation_schema_mismatch');
  return { kind: 'donation', uid: String(d.uid), owner: pin.owner, actorId: String(d.id), actorName: String(d.name || ''), amount: Number(d.value), subtype: d.subtype, sourceTime: d.time, receivedAt, payloadHash: hash(d) };
}
// Mutual uniqueness prevents two equal-amount donations being paired by guesswork.
export function compareDonations(events, baseline, pin, windowMs = 120000) {
  if (baseline.workspaceId !== pin.workspaceId || baseline.owner !== pin.owner || !baseline.complete) throw Error('baseline_scope_or_pagination_incomplete');
  if (baseline.donations.some(d => d.workspace_id !== pin.workspaceId || (d.source_bj_id && d.source_bj_id !== pin.owner))) throw Error('baseline_account_mismatch');
  const seen = new Map(), duplicates = [], conflicts = [];
  for (const e of events) {
    if (e.owner !== pin.owner) throw Error('candidate_account_mismatch');
    const old = seen.get(e.uid);
    if (old) (old.payloadHash === e.payloadHash ? duplicates : conflicts).push(e.uid);
    else seen.set(e.uid, e);
  }
  const candidates = [...seen.values()];
  const possible = e => baseline.donations.filter(d => d.actor_id === e.actorId && Number(d.amount) === e.amount && Math.abs(Date.parse(d.occurred_at) - Date.parse(e.receivedAt)) <= windowMs);
  const pairs = candidates.map(e => ({ event: e, matches: possible(e) }));
  const counts = new Map();
  for (const p of pairs) for (const d of p.matches) counts.set(d.id, (counts.get(d.id) || 0) + 1);
  const matched = [], pending = [], ambiguous = [];
  for (const p of pairs) {
    if (!p.matches.length) pending.push(p.event.uid);
    else if (p.matches.length !== 1 || counts.get(p.matches[0].id) !== 1) ambiguous.push(p.event.uid);
    else matched.push({ uid: p.event.uid, donationId: p.matches[0].id, databaseWriteMinusReceiptMs: Date.parse(p.matches[0].created_at) - Date.parse(p.event.receivedAt) });
  }
  const matchedIds = new Set(matched.map(x => x.donationId));
  return { matched, pending, ambiguous, duplicates, conflicts, baselineUnpaired: baseline.donations.filter(d => !matchedIds.has(d.id)).map(d => d.id), latencyMeaning: 'database created_at minus candidate receipt; not transport latency', conclusion: 'unpaired events require connection coverage and donation-type review; no automatic success' };
}
export function classifyResult(response) {
  if (response?.result !== 'success') return { status: 'needs_review', reason: 'result_error' };
  if (!['sql', 'mem'].includes(response.api)) return { status: 'needs_review', reason: 'possible_result_generation', api: response.api };
  let list = response.list;
  if (typeof list === 'string' && list) { try { list = JSON.parse(list); } catch { return { status: 'needs_review', reason: 'list_parse' }; } }
  const results = Array.isArray(list) && list.length ? list.map(x => Array.isArray(x) ? x[0] : null) : [response.data];
  if (results.some(x => typeof x !== 'string')) return { status: 'needs_review', reason: 'result_schema' };
  return { status: 'stored_result_observed', results, api: response.api };
}
