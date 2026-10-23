// Run from /app in an isolated copy of the deployed gateway image. No tokens,
// production volumes or gateway worker: only public SDK pages and constructors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {closeSoopBrowserHost,openSoopSharedBrowserProbeSessions} from 'file:///app/services/soop-chat-gateway/browser-session.mjs';

const sample=()=>Object.fromEntries(['memory.current','memory.peak','memory.events','pids.current','pids.peak'].map(name=>[name,fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim()]));
const rounds=[];
try {
  for(let cycle=0;cycle<5;cycle++){
    let probe;
    try {
      const start=performance.now();
      probe=await openSoopSharedBrowserProbeSessions(5);
      assert.equal(probe.targetCount,5);
      assert.equal(probe.shardCount,5);
      assert.equal(probe.sessionsPerShard,1);
      await new Promise(resolve=>setTimeout(resolve,2000));
      rounds.push({cycle:cycle+1,creationAndSettleMs:Math.round(performance.now()-start),...sample()});
    } finally { await probe?.close(); }
  }
} finally { await closeSoopBrowserHost(); }
const final=sample();
const events=Object.fromEntries(final['memory.events'].split('\n').map(line=>line.split(' ')));
assert.equal(Number(events.oom_kill),0);
assert.equal(Number(events.oom),0);
console.log(JSON.stringify({kind:'isolated_sdk_page_capacity',sessions:5,cycles:5,rounds,final,
  limitation:'No authenticated sockets, live donations, API delivery, queue replay or 4GB-host boot tested.'}));
