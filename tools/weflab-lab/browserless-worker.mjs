import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessLookup, digest } from './browserless-core.mjs';

export function createClient({ url, id, secret }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw Error('encrypted_transport_required');
  return async request => {
    const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-worker-id': id, authorization: 'Bearer ' + secret }, body: JSON.stringify(request) });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'coordinator_unavailable');
    return data;
  };
}

export function privateReceipt(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Host calls tick after checking its intake connection, typically every 3 seconds.
// Merely starting an Agent is not a readiness signal. Never overlap ticks.
export class OwnershipWorker {
  constructor({ rpc, directory, fetchResult }) { Object.assign(this, { rpc, directory, fetchResult }); }
  async tick({ ready, confirmedKeys = [] }) {
    if (this.busy) throw Error('worker_tick_in_progress');
    this.busy = true;
    try {
      const lease = await this.rpc({ action: 'heartbeat', ready: ready === true });
      if (lease.status === 'draining') {
        try { return await this.rpc({ action: 'release', token: lease.token }); }
        catch (e) { if (e.message === 'request_in_flight') return { status: 'draining' }; throw e; }
      }
      if (lease.status !== 'owner' || ready !== true) return lease;
      const jobs = [];
      for (const key of confirmedKeys) {
        const result = await runConfirmedTest({ rpc: this.rpc, key, directory: this.directory, fetchResult: this.fetchResult });
        jobs.push(result);
        if (['needs_review', 'standby', 'draining'].includes(result.status)) break;
      }
      return { status: 'owner', jobs };
    } finally { this.busy = false; }
  }
}

// One attempt, no HTTP retry. Caller keeps raw socket intake separate from result requests.
// The same portable worker can run on a server or PC; this is not yet packaged into Agent.
export async function runConfirmedTest({ rpc, key, directory, fetchResult = fetch }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lease = await rpc({ action: 'heartbeat', ready: true });
  if (lease.status !== 'owner') return { status: lease.status };
  const reserved = await rpc({ action: 'reserve', token: lease.token, key });
  if (reserved.status !== 'request_reserved') return reserved;
  const plan = reserved.plan;
  if (!plan.test || plan.key !== key || digest(plan.body) !== plan.requestHash) throw Error('invalid_reserved_plan');
  const base = path.join(directory, `${key}-${reserved.attempt}`);
  privateReceipt(base + '-started.private.json', { at: new Date().toISOString(), plan, attempt: reserved.attempt });
  let outcome, raw, response;
  try {
    response = await fetchResult('https://weflab.com/api/', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body: new URLSearchParams(plan.body) });
    raw = await response.text();
    let parsed; try { parsed = JSON.parse(raw); } catch {}
    outcome = response.ok ? assessLookup(parsed, plan.count) : { status: 'needs_review', reason: 'provider_http' };
  } catch { outcome = { status: 'needs_review', reason: 'uncertain_request_do_not_repeat' }; }
  // Full response is retained privately before sending any result to the coordinator.
  privateReceipt(base + '-response.private.json', { at: new Date().toISOString(), status: response?.status, raw, outcome });
  try {
    const completion = await rpc({ action: 'complete', token: lease.token, key, attempt: reserved.attempt, outcome });
    return { ...completion, api: outcome.api };
  } catch {
    return { status: 'needs_review', reason: 'completion_unconfirmed_private_response_retained' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [configFile, directory, approval] = process.argv.slice(2);
  if (approval !== '--confirmed-test') throw Error('operator_confirmation_required');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  console.log(JSON.stringify(await runConfirmedTest({ rpc: createClient(config), key: config.key, directory })));
}
