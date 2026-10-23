import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CollectionCoordinator } from './browserless-core.mjs';

// Private candidate store: a durable append-only journal, never an operating DB.
// A crash leaves the lock for operator recovery. Never guess whether another owner is alive.
export function openJournal(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'coordinator.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  const file = path.join(directory, 'state.private.jsonl');
  let journal;
  try {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (raw && !raw.endsWith('\n')) throw Error('incomplete_journal_requires_review');
    const states = raw.split('\n').filter(Boolean).map(JSON.parse);
    journal = fs.openSync(file, 'a', 0o600);
    let size = Buffer.byteLength(raw), closed = false;
    return {
      state: states.at(-1),
      persist(state) {
        if (closed) throw Error('closed_store');
        const row = Buffer.from(JSON.stringify(state) + '\n');
        if (size + row.length > 64 * 1024 * 1024) throw Error('journal_capacity');
        let offset = 0;
        while (offset < row.length) offset += fs.writeSync(journal, row, offset, row.length - offset);
        fs.fsyncSync(journal); size += row.length;
      },
      close() { if (!closed) { closed = true; fs.closeSync(journal); fs.closeSync(fd); fs.unlinkSync(lock); } }
    };
  } catch (e) {
    if (journal != null) fs.closeSync(journal);
    fs.closeSync(fd); fs.unlinkSync(lock); throw e;
  }
}

function authorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const a = Buffer.from(header || ''), b = Buffer.from('Bearer ' + secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Loopback-only research RPC. Expose remotely only through an authenticated encrypted tunnel.
// Plans/proofs come from operator-owned config, never from a worker-supplied donation or account.
export async function startCoordinator({ config, directory, port = 0, now }) {
  const store = openJournal(directory);
  let coordinator;
  try { coordinator = new CollectionCoordinator({ scope: config.scope,
    workers: Object.fromEntries(Object.entries(config.workers).map(([id, w]) => [id, w.role])),
    persist: s => store.persist(s), state: store.state, ttlMs: config.ttlMs, now }); }
  catch (e) { store.close(); throw e; }
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') return respond(404, { error: 'not_found' });
      const id = req.headers['x-worker-id'];
      if (typeof id !== 'string' || !Object.hasOwn(config.workers, id) || !authorized(req.headers.authorization, config.workers[id].secret)) return respond(401, { error: 'unauthorized' });
      let body = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return respond(413, { error: 'body_limit' }); body += chunk; }
      const q = JSON.parse(body);
      let result;
      if (q.action === 'heartbeat') result = coordinator.heartbeat(id, q.ready);
      else if (q.action === 'release') result = coordinator.release(id, q.token);
      else if (q.action === 'reserve') {
        const l = coordinator.valid(id, q.token);
        if (l.draining) throw Error('handoff_draining');
        const entry = config.confirmedTests?.find(x => x.plan.key === q.key);
        if (!entry) throw Error('test_not_approved');
        result = coordinator.reserve(id, q.token, entry.plan, entry.proof);
        if (result.status === 'request_reserved') result.plan = entry.plan;
      } else if (q.action === 'complete') result = coordinator.complete(id, q.token, q.key, q.attempt, q.outcome);
      else throw Error('unknown_action');
      respond(200, result);
    } catch (e) {
      // No payload, credential or provider response in HTTP errors.
      const code = /^[a-z_]+$/.test(e.message) ? e.message : 'invalid_request';
      respond(409, { error: code });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (e) { store.close(); throw e; }
  return { url: `http://127.0.0.1:${server.address().port}/rpc`, coordinator,
    async close() { await new Promise(resolve => server.close(resolve)); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, directory] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const service = await startCoordinator({ config, directory, port: config.port });
  console.log(JSON.stringify({ status: 'candidate_ready', url: service.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
