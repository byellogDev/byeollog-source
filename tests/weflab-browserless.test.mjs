import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookupPlan, assessLookup, CollectionCoordinator, digest } from '../tools/weflab-lab/browserless-core.mjs';
import { openJournal, startCoordinator } from '../tools/weflab-lab/browserless-service.mjs';
import { createClient, runConfirmedTest, OwnershipWorker } from '../tools/weflab-lab/browserless-worker.mjs';

const pin = { workspaceId: 'fixture-workspace', owner: 'fixture-owner', idx: '7', preset: '1' };
const context = { type: 'page', pageid: 'alert', idx: 7, preset: 1, platform: { afreeca: { id: pin.owner } } };
const rules = { data: { checkbox: { item_alert_rouletteuse: 'on' }, donation: { item_roulette_donation: [{
  checkbox: { setup_roulette_use: 'on' }, text: { setup_alert_giftmin: '30', setup_alert_giftmax: '30' },
  roulette: { setup_roulette: [{ name: '꽝', percent: '90' }, { name: '당첨', percent: '10' }] }
}] } } };
const event = { type: 'test_donation', data: { platform: 'afreeca', type: 'SENDBALLOON', uid: 'fixture', value: 30, time: 1234 } };
const plan = lookupPlan(context, pin, event, rules);
const proof = { kind: 'operator_confirmed_test', key: plan.key, requestHash: plan.requestHash, at: new Date(1).toISOString(), expected: ['꽝'] };
function fixture() {
  let time = 10000, state;
  const options = { scope: pin, workers: { server: 'server', agent: 'agent', other: 'agent' }, now: () => time, persist: s => { state = s; } };
  const c = new CollectionCoordinator(options);
  return { c, advance: n => time += n, restart: () => new CollectionCoordinator({ ...options, state }) };
}
const complete = (c, l, job) => c.complete(l.owner, l.token, plan.key, job.attempt, { status: 'stored_result_observed', api: 'sql', results: ['꽝'] });

test('exact original test identity and request; no bot or baseline required', () => {
  assert.equal(plan.body.uid, 'fixture301234'); assert.equal(plan.body.id, 'test');
  assert.equal(plan.body.roulette, '{"꽝":"90","당첨":"10"}');
  assert.equal(plan.count, 1); assert.equal(plan.requestHash, digest(plan.body));
});
test('reject wrong account, replay, forced result and range rules', () => {
  assert.throws(() => lookupPlan({ ...context, idx: 9 }, pin, event, rules), /context_scope/);
  assert.throws(() => lookupPlan(context, pin, { ...event, data: { ...event.data, replay: true } }, rules), /unsupported_event/);
  assert.throws(() => lookupPlan(context, pin, { ...event, data: { ...event.data, testroulette: 'forced' } }, rules), /override/);
  const r = structuredClone(rules); r.data.donation.item_roulette_donation[0].text.setup_alert_giftmin = '1';
  assert.throws(() => lookupPlan(context, pin, event, r), /unsupported_range/);
});
test('ambiguous rules, duplicate choices and invalid spin count stop', () => {
  const r = structuredClone(rules); r.data.donation.item_roulette_donation.push(r.data.donation.item_roulette_donation[0]);
  assert.throws(() => lookupPlan(context, pin, event, r), /ambiguous_rule/);
  const x = structuredClone(rules), rule = x.data.donation.item_roulette_donation[0];
  rule.roulette.setup_roulette.push({ name: '꽝', percent: '1' });
  assert.throws(() => lookupPlan(context, pin, event, x), /ambiguous_choice/);
  rule.checkbox.setup_roulette_double = 'on'; rule.select = { setup_roulette_doublecount: '0' };
  assert.throws(() => lookupPlan(context, pin, event, x), /spin_count/);
});
test('save, wrong count, blank result and malformed list are not accepted', () => {
  assert.equal(assessLookup({ result: 'success', api: 'save', data: '꽝' }, 1).status, 'needs_review');
  assert.equal(assessLookup({ result: 'success', api: 'sql', data: '' }, 1).status, 'needs_review');
  assert.equal(assessLookup({ result: 'success', api: 'sql', list: 'invalid' }, 1).status, 'needs_review');
  assert.equal(assessLookup({ result: 'success', api: 'mem', data: '꽝' }, 2).status, 'needs_review');
  assert.equal(assessLookup({ result: 'success', api: 'mem', list: '[["꽝",90]]' }, 1).status, 'stored_result_observed');
});
test('server default; unready Agent does not take over; ready Agent drains server', () => {
  const { c } = fixture(), l = c.heartbeat('server', true);
  assert.equal(l.status, 'owner'); c.heartbeat('agent', false);
  assert.equal(c.heartbeat('server', true).status, 'owner'); c.heartbeat('agent', true);
  assert.equal(c.heartbeat('server', true).status, 'draining');
  assert.throws(() => c.reserve('server', l.token, plan, proof), /handoff_draining/);
  c.release('server', l.token);
  assert.equal(c.heartbeat('agent', true).status, 'owner');
});
test('in-flight request blocks clean release; completes before takeover', () => {
  const { c } = fixture(), l = c.heartbeat('server', true), job = c.reserve('server', l.token, plan, proof);
  c.heartbeat('agent', true);
  assert.throws(() => c.release('server', l.token), /request_in_flight/);
  complete(c, l, job); c.release('server', l.token);
  const a = c.heartbeat('agent', true);
  assert.equal(c.reserve('agent', a.token, plan, proof).status, 'already_reserved');
});
test('Agent failure falls back, old owner is fenced, uncertain query never repeats', () => {
  const f = fixture(), l = f.c.heartbeat('agent', true), job = f.c.reserve('agent', l.token, plan, proof);
  f.advance(15001); const server = f.c.heartbeat('server', true);
  assert.equal(server.status, 'owner'); assert.throws(() => complete(f.c, l, job), /stale_lease/);
  assert.equal(f.c.reserve('server', server.token, plan, proof).status, 'already_reserved');
  const restored = f.restart();
  assert.equal(restored.reserve('server', server.token, plan, proof).status, 'already_reserved');
});
test('multiple ready Agents do not displace an active Agent', () => {
  const { c } = fixture(); c.heartbeat('agent', true);
  assert.equal(c.heartbeat('other', true).status, 'standby');
  assert.equal(c.heartbeat('agent', true).status, 'owner');
});
test('no production request, unconfirmed test, forged plan or cross-account request', () => {
  const { c } = fixture(), l = c.heartbeat('server', true);
  assert.throws(() => c.reserve('server', l.token, plan, {}), /completion_proof_required/);
  assert.throws(() => c.reserve('server', l.token, { ...plan, owner: 'wrong' }, proof), /plan_scope/);
  assert.throws(() => c.reserve('server', l.token, { ...plan, body: {} }, proof), /plan_scope/);
  const p = { ...plan, test: false }; p.key = digest([p.workspaceId, p.owner, false, p.uid]);
  assert.throws(() => c.reserve('server', l.token, p, { ...proof, key: p.key }), /completion_proof_required/);
  assert.throws(() => c.heartbeat('__proto__', true), /worker_not_allowed/);
});
test('same donation with changed request and unexpected result rejected', () => {
  const { c } = fixture(), l = c.heartbeat('server', true), job = c.reserve('server', l.token, plan, proof);
  const p = { ...plan, body: { ...plan.body, count: '2' } }; p.requestHash = digest(p.body);
  assert.throws(() => c.reserve('server', l.token, p, proof), /changed_request/);
  assert.throws(() => c.complete('server', l.token, plan.key, job.attempt, { status: 'stored_result_observed', api: 'sql', results: ['당첨'] }), /unconfirmed_outcome/);
});
test('disk failure poisons coordinator before any external query', () => {
  const c = new CollectionCoordinator({ scope: pin, workers: { server: 'server' }, persist: () => { throw Error('disk'); } });
  assert.throws(() => c.heartbeat('server', true), /durability_failed_stop/);
  assert.throws(() => c.heartbeat('server', true), /durability_failed_stop/);
});
test('durable journal: exclusive writer, restart recovery, partial row rejected', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflab-candidate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = openJournal(dir); j.persist({ value: 1 });
  assert.throws(() => openJournal(dir), /EEXIST/); j.close();
  const restored = openJournal(dir); assert.equal(restored.state.value, 1); restored.close();
  fs.appendFileSync(path.join(dir, 'state.private.jsonl'), '{partial');
  assert.throws(() => openJournal(dir), /incomplete_journal/);
});
test('HTTP two-worker handoff with one external request and durable private response', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflab-rpc-'));
  const config = { scope: pin, workers: { server: { role: 'server', secret: 's'.repeat(40) }, agent: { role: 'agent', secret: 'a'.repeat(40) } }, confirmedTests: [{ plan, proof }] };
  const service = await startCoordinator({ config, directory: path.join(dir, 'journal') });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = id => createClient({ url: service.url, id, secret: config.workers[id].secret });
  const server = client('server'), agent = client('agent');
  const l = await server({ action: 'heartbeat', ready: true });
  await agent({ action: 'heartbeat', ready: true });
  assert.equal((await server({ action: 'heartbeat', ready: true })).status, 'draining');
  await server({ action: 'release', token: l.token });
  let calls = 0;
  const options = { rpc: agent, key: plan.key, directory: path.join(dir, 'receipts'), fetchResult: async (url, req) => {
    calls++; assert.equal(url, 'https://weflab.com/api/'); assert.equal(req.body.get('uid'), plan.uid);
    return new Response(JSON.stringify({ result: 'success', api: 'sql', data: '꽝' }));
  } };
  assert.equal((await runConfirmedTest(options)).status, 'stored_result_observed');
  assert.equal((await runConfirmedTest(options)).status, 'already_reserved'); assert.equal(calls, 1);
  assert.equal(fs.readdirSync(options.directory).length, 2);
  const bad = createClient({ url: service.url, id: 'agent', secret: 'x'.repeat(40) });
  await assert.rejects(() => bad({ action: 'heartbeat', ready: true }), /unauthorized/);
  const active = await agent({ action: 'heartbeat', ready: true });
  await assert.rejects(() => agent({ action: 'reserve', token: active.token, key: 'other-account' }), /test_not_approved/);
});

test('worker ticks release automatically for a ready Agent, then server resumes on loss', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflab-handoff-'));
  let now = 10000;
  const config = { scope: pin, workers: { server: { role: 'server', secret: 's'.repeat(40) }, agent: { role: 'agent', secret: 'a'.repeat(40) } } };
  const service = await startCoordinator({ config, directory: dir, now: () => now });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const worker = id => new OwnershipWorker({ rpc: createClient({ url: service.url, id, secret: config.workers[id].secret }), directory: path.join(dir, id) });
  const server = worker('server'), agent = worker('agent');
  assert.equal((await server.tick({ ready: true })).status, 'owner');
  assert.equal((await agent.tick({ ready: false })).status, 'standby');
  assert.equal((await server.tick({ ready: true })).status, 'owner');
  assert.equal((await agent.tick({ ready: true })).status, 'standby');
  assert.equal((await server.tick({ ready: true })).status, 'released');
  assert.equal((await agent.tick({ ready: true })).status, 'owner');
  assert.equal((await server.tick({ ready: true })).status, 'standby');
  now += 15001;
  assert.equal((await server.tick({ ready: true })).status, 'owner');
});

test('provider timeout is reserved permanently and never automatically retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflab-timeout-'));
  const config = { scope: pin, workers: { server: { role: 'server', secret: 's'.repeat(40) } }, confirmedTests: [{ plan, proof }] };
  const service = await startCoordinator({ config, directory: path.join(dir, 'journal') });
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let calls = 0;
  const options = { rpc: createClient({ url: service.url, id: 'server', secret: config.workers.server.secret }), key: plan.key,
    directory: path.join(dir, 'responses'), fetchResult: async () => { calls++; throw Error('timeout'); } };
  assert.equal((await runConfirmedTest(options)).status, 'needs_review');
  assert.equal((await runConfirmedTest(options)).status, 'already_reserved'); assert.equal(calls, 1);
});
