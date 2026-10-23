import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hash, loadContext, loadRules, joinMessage, normalize } from './protocol.mjs';

const require = createRequire(process.env.WEFLAB_DEPENDENCY_ANCHOR || import.meta.url);
const WebSocket = require('ws');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const lock = path.join(out, 'observer.lock');
const lockFd = fs.openSync(lock, 'wx', 0o600); // stale lock deliberately needs review
fs.writeFileSync(lockFd, String(process.pid));
process.on('exit', () => { fs.closeSync(lockFd); fs.unlinkSync(lock); });
process.umask(0o077);
let stopped = false, c, totalBytes = 0, fileIndex = 0, fileBytes = 0;
const maxBytes = cfg.maxBytes || 512 * 1024 * 1024;
const state = { status: 'starting', startedAt: new Date().toISOString(), channels: {}, donations: 0, tests: 0, unknown: 0, duplicateTransportEvents: 0, resultApiCalls: 0 };
const sockets = new Set(), timers = new Set(), seen = new Map();
const now = () => new Date().toISOString();
for (const f of fs.readdirSync(out)) if (/^evidence-.*\.jsonl$/.test(f)) totalBytes += fs.statSync(path.join(out, f)).size;
const epoch = Date.now();
function saveStatus() {
  const temp = path.join(out, 'status.tmp');
  fs.writeFileSync(temp, JSON.stringify({ ...state, at: now(), totalBytes, rss: process.memoryUsage().rss }));
  fs.renameSync(temp, path.join(out, 'status.json'));
}
function stop(reason, error = false) {
  if (stopped) return;
  stopped = true; state.status = error ? 'needs_review' : 'stopped'; state.reason = reason; state.stoppedAt = now();
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  for (const s of sockets) s.terminate();
  saveStatus();
  setTimeout(() => process.exit(error ? 2 : 0), 50);
}
function record(kind, data) {
  if (stopped) return;
  const line = JSON.stringify({ at: now(), kind, ...data }) + '\n';
  const size = Buffer.byteLength(line);
  if (totalBytes + size > maxBytes) { stop('evidence_capacity_reached', true); return; }
  if (fileBytes + size > 16 * 1024 * 1024) { fileIndex++; fileBytes = 0; }
  fs.appendFileSync(path.join(out, `evidence-${epoch}-${fileIndex}.jsonl`), line, { mode: 0o600 });
  totalBytes += size; fileBytes += size;
}
async function rules() {
  const data = await loadRules(c);
  record('rules', { hash: hash(data), data });
}
function connect(channel, attempts = 0) {
  if (stopped) return;
  const base = channel === 'main' ? c.config.url.socket : c.config.url.socket_afreeca;
  const url = new URL('/socket.io/', base); url.protocol = 'wss:';
  for (const [k, v] of Object.entries({ EIO: '4', transport: 'websocket', idx: c.idx, type: c.type, page: c.pageid })) url.searchParams.set(k, v);
  const ws = new WebSocket(url, { origin: 'https://weflab.com', handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
  sockets.add(ws);
  let last = Date.now(), heartbeatMs = 45000, joinedAt;
  state.channels[channel] = { status: 'connecting', at: now() };
  record('connecting', { channel, attempt: attempts });
  const watchdog = setInterval(() => { if (Date.now() - last > heartbeatMs) ws.terminate(); }, 5000); timers.add(watchdog);
  ws.on('message', bytes => {
    last = Date.now(); const raw = bytes.toString();
    try {
      if (raw.startsWith('0')) {
        const hello = JSON.parse(raw.slice(1));
        heartbeatMs = Math.min(120000, Math.max(15000, Number(hello.pingInterval || 25000) + Number(hello.pingTimeout || 20000) + 5000));
        ws.send('40'); return;
      }
      if (raw === '2') { ws.send('3'); return; }
      if (raw.startsWith('40')) {
        ws.send('42' + JSON.stringify(['msg', joinMessage(c, channel)]));
        joinedAt = now(); attempts = 0;
        state.channels[channel] = { status: 'join_sent', at: joinedAt };
        record('join_sent', { channel }); saveStatus(); return;
      }
      if (raw === '41' || raw.startsWith('44')) { record('namespace_disconnect', { channel, raw }); ws.terminate(); return; }
      if (!raw.startsWith('42')) { record('unknown_frame', { channel, raw }); return; }
      record('raw', { channel, raw }); // preserve before parsing or normalization
      const event = JSON.parse(raw.slice(2));
      const n = normalize(event, cfg, now());
      if (n.kind === 'donation') {
        const old = seen.get(n.uid);
        if (old && old !== n.payloadHash) throw Error('same_uid_changed_payload');
        if (old) state.duplicateTransportEvents++;
        else {
          if (seen.size >= 100000) throw Error('dedup_capacity_reached');
          seen.set(n.uid, n.payloadHash); state.donations++;
        }
      } else if (n.kind === 'test_or_replay') state.tests++;
      else if (n.kind === 'unknown' || n.kind === 'unsupported_donation') state.unknown++;
      record('normalized', { channel, event: n });
      if (event[1]?.type === 'load' || event[1]?.type === 'refresh' || event[1]?.type === 'refresh_all') rules().catch(() => stop('rule_refresh_failed', true));
    } catch (e) { record('failure', { channel, reason: String(e.message).slice(0,120), raw }); stop('protocol_or_isolation_failure', true); }
  });
  ws.on('error', () => record('socket_error', { channel }));
  ws.on('close', (code) => {
    clearInterval(watchdog); timers.delete(watchdog); sockets.delete(ws);
    if (stopped) return;
    state.channels[channel] = { status: 'disconnected', at: now(), code };
    record('disconnected', { channel, code, joinedAt }); saveStatus();
    const t = setTimeout(() => { timers.delete(t); connect(channel, attempts + 1); }, Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)) + Math.random() * 1000); timers.add(t);
  });
}
process.on('SIGTERM', () => stop('operator_or_service_stop'));
process.on('SIGINT', () => stop('operator_stop'));
try {
  if (!Number.isFinite(Date.parse(cfg.startAt)) || Date.now() < Date.parse(cfg.startAt)) throw Error('before_scheduled_start');
  c = await loadContext(cfg);
  record('context_verified', { owner: cfg.owner, workspaceId: cfg.workspaceId, preset: c.preset });
  await rules();
  state.status = 'observing_receive_only';
  connect('main'); connect('afreeca');
  let cpu = process.cpuUsage();
  const metrics = setInterval(() => {
    const usage = process.cpuUsage(cpu); cpu = process.cpuUsage();
    record('metrics', { memory: process.memoryUsage(), cpuMicroseconds: usage, channels: state.channels }); saveStatus();
  }, 30000); timers.add(metrics);
  // No platform/start, renderer, roulette_result, bot, DB write or production credential.
  saveStatus();
} catch (e) { record('failure', { reason: String(e.message).slice(0,120) }); stop('startup_failed', true); }
