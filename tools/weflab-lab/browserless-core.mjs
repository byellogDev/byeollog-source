import { createHash, randomUUID } from 'node:crypto';
import { classifyResult } from './protocol.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error(reason); };

// Reconstruct only the verified exact-amount SOOP rule, never invent a UID.
export function lookupPlan(context, pin, message, rules) {
  if (context.type !== 'page' || context.pageid !== 'alert' || String(context.idx) !== String(pin.idx) ||
      String(context.preset) !== String(pin.preset) || context.platform?.afreeca?.id !== pin.owner) fail('context_scope');
  const test = message.type === 'test_donation';
  const d = message.data;
  if (!d || d.replay || message.type === 'alert_replay') fail('unsupported_event');
  if (message.idx != null && String(message.idx) !== String(pin.idx)) fail('event_scope');
  if (message.preset != null && String(message.preset) !== String(pin.preset)) fail('event_scope');
  if (test ? d.platform !== 'afreeca' || d.type !== 'SENDBALLOON' || d.testroulette :
    message.type !== 'alert' || message.platform !== 'afreeca' || message.id !== pin.owner || d.subtype !== 'SENDBALLOON') fail('event_scope_or_override');
  const amount = Number(d.value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e9) fail('amount');
  let uid = d.uid;
  if (test) {
    if (!Number.isFinite(Number(d.time)) || Number(d.time) <= 0) fail('test_time');
    // Same test-event identity construction as the original page (not a real donation ID).
    uid = String(d.uid !== undefined && d.uid !== '' ? d.uid : '위플랩도우미') + String(d.value) + String(d.time);
  }
  if (typeof uid !== 'string' || !uid || uid.length > 512) fail('uid');
  if (rules.data?.checkbox?.item_alert_rouletteuse !== 'on') fail('roulette_disabled');
  const matches = (rules.data?.donation?.item_roulette_donation || []).filter(r =>
    r.checkbox?.setup_roulette_use === 'on' && Number(r.text?.setup_alert_giftmin) <= amount && Number(r.text?.setup_alert_giftmax) >= amount);
  if (matches.length !== 1) fail('ambiguous_rule');
  const r = matches[0];
  if (Number(r.text.setup_alert_giftmin) !== amount || Number(r.text.setup_alert_giftmax) !== amount || r.checkbox.setup_roulette_range === 'on') fail('unsupported_range');
  const count = r.checkbox.setup_roulette_double === 'on' ? Number(r.select?.setup_roulette_doublecount) : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('spin_count');
  const roulette = Object.create(null);
  for (const v of r.roulette?.setup_roulette || []) {
    if (v.name === '' || v.percent === '') continue;
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 2048 || !Number.isFinite(Number(v.percent)) || Number(v.percent) < 0) fail('choice_shape');
    const name = v.name.trim();
    if (Object.hasOwn(roulette, name) || name === '__proto__' || name === 'constructor') fail('ambiguous_choice');
    roulette[name] = v.percent;
  }
  if (Object.keys(roulette).length < 2 || Object.keys(roulette).length > 500) fail('choice_count');
  const body = { type: 'roulette_result', pagetype: context.type, idx: String(context.idx), platform: 'afreeca', id: test ? 'test' : pin.owner,
    uid, value: String(amount), count: String(count), roulette: JSON.stringify(roulette) };
  const ruleHash = digest(r);
  return { workspaceId: pin.workspaceId, owner: pin.owner, uid, test, count, ruleHash,
    key: digest([pin.workspaceId, pin.owner, test, uid]), requestHash: digest(body), body };
}

export function assessLookup(response, expectedCount) {
  const result = classifyResult(response);
  if (result.status !== 'stored_result_observed') return result;
  if (result.results.length !== expectedCount || result.results.some(x => !x.trim() || x.length > 2048))
    return { status: 'needs_review', reason: 'result_count_or_shape', api: response.api };
  return result;
}

// Single authoritative coordinator. 'persist' must commit durably before returning.
// A lease alone cannot fence a third-party HTTP call: each donation also has a permanent request reservation.
export class CollectionCoordinator {
  constructor({ scope, workers, now = Date.now, persist, state, ttlMs = 15000 }) {
    if (!scope?.workspaceId || !scope.owner || typeof persist !== 'function' || !workers || ttlMs < 3000 || ttlMs > 60000) fail('coordinator_config');
    this.scope = scope; this.workers = workers; this.now = now; this.persist = persist; this.ttlMs = ttlMs;
    this.state = state || { scope, epoch: 0, lease: null, workers: {}, jobs: {} };
    if (digest(this.state.scope) !== digest(scope)) fail('state_scope');
  }
  save() { try { this.persist(structuredClone(this.state)); } catch { this.poisoned = true; fail('durability_failed_stop'); } }
  identify(id) {
    if (this.poisoned) fail('durability_failed_stop');
    if (!Object.hasOwn(this.workers, id) || !['server', 'agent'].includes(this.workers[id])) fail('worker_not_allowed');
    return this.workers[id];
  }
  valid(id, token) {
    this.identify(id); const l = this.state.lease;
    if (!l || l.owner !== id || l.token !== token || l.until <= this.now()) fail('stale_lease');
    return l;
  }
  heartbeat(id, ready) {
    const role = this.identify(id), now = this.now();
    this.state.workers[id] = { ready: ready === true, seen: now, role };
    let l = this.state.lease;
    if (l && l.until <= now) { this.state.lease = null; l = null; }
    const agent = Object.entries(this.state.workers).filter(([key, w]) => this.workers[key] === 'agent' && w.ready && now - w.seen < this.ttlMs).sort(([a], [b]) => a.localeCompare(b))[0]?.[0];
    if (l && agent && this.workers[l.owner] === 'server') l.draining = true;
    if (l?.owner === id && !ready) l.draining = true;
    if (l?.owner === id && ready && !l.draining) l.until = now + this.ttlMs;
    if (!l && ready && (role === 'agent' || !agent)) {
      l = { owner: id, token: randomUUID(), epoch: ++this.state.epoch, until: now + this.ttlMs, draining: false };
      this.state.lease = l;
    }
    this.save();
    return l?.owner === id ? { status: l.draining ? 'draining' : 'owner', ...l } : { status: 'standby', owner: l?.owner || null };
  }
  release(id, token) {
    this.valid(id, token);
    if (Object.values(this.state.jobs).some(j => j.status === 'request_reserved' && j.worker === id && j.token === token)) fail('request_in_flight');
    this.state.lease = null; this.save(); return { status: 'released' };
  }
  reserve(id, token, plan, proof) {
    const l = this.valid(id, token);
    if (l.draining) fail('handoff_draining');
    if (plan.workspaceId !== this.scope.workspaceId || plan.owner !== this.scope.owner ||
        plan.key !== digest([plan.workspaceId, plan.owner, plan.test, plan.uid]) || plan.requestHash !== digest(plan.body)) fail('plan_scope');
    if (this.state.jobs[plan.key]) {
      if (this.state.jobs[plan.key].requestHash !== plan.requestHash) fail('same_donation_changed_request');
      return { status: 'already_reserved', jobStatus: this.state.jobs[plan.key].status };
    }
    // Live use is intentionally test-only until a non-generating contract exists.
    if (!plan.test || proof?.kind !== 'operator_confirmed_test' || proof.key !== plan.key || proof.requestHash !== plan.requestHash ||
        !Number.isFinite(Date.parse(proof.at)) || Date.parse(proof.at) > this.now() || !Array.isArray(proof.expected) || proof.expected.length !== plan.count ||
        proof.expected.some(x => typeof x !== 'string' || !x.trim() || x.length > 2048)) fail('completion_proof_required');
    if (Object.keys(this.state.jobs).length >= 10000) fail('job_capacity');
    const attempt = randomUUID();
    this.state.jobs[plan.key] = { status: 'request_reserved', worker: id, token, epoch: l.epoch, attempt, requestHash: plan.requestHash, reservedAt: this.now(), proof };
    this.save(); // Even a crash before HTTP leaves the job reserved, never automatically replayed.
    return { status: 'request_reserved', attempt };
  }
  complete(id, token, key, attempt, outcome) {
    this.valid(id, token); const j = this.state.jobs[key];
    if (!j || j.worker !== id || j.token !== token || j.attempt !== attempt || j.status !== 'request_reserved') fail('attempt_mismatch');
    if (!['stored_result_observed', 'needs_review'].includes(outcome.status)) fail('outcome_shape');
    if (outcome.status === 'stored_result_observed' &&
        (!['sql', 'mem'].includes(outcome.api) || digest(outcome.results) !== digest(j.proof.expected))) fail('unconfirmed_outcome');
    j.status = outcome.status; j.outcome = outcome; j.completedAt = this.now(); this.save();
    return { status: j.status };
  }
}
