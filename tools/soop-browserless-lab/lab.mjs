// Isolated feasibility experiment. Never imported by the operating gateway.
// Official SDK is loaded unchanged; all HTTP is synthetic, all WS is loopback.
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance, monitorEventLoopDelay} from 'node:perf_hooks';
import {WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {classifySoopChatSdkCallback} from '../../services/soop-gateway/lib/soop-chat-gateway.js';

const source = fs.readFileSync(new URL('../../.local/soop-browserless-lab/sdk.js', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'4d6974d882013e4cae2797010668855d3c2aeb0d2a8f711b08f65578c118a016','SDK fixture version changed');
const compiled = new vm.Script(source, {filename:'official-soop-sdk.js'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const until = async (fn, ms=10000) => {const end=Date.now()+ms; while(!fn()){if(Date.now()>end)throw Error('condition_timeout');await sleep(10)}};
const mb = n=>Math.round(n/1024/1024*10)/10;
const packet = (code, fields) => {
  const body=Buffer.from('\f'+fields.join('\f')+'\f','utf8');
  return Buffer.concat([Buffer.from('\x1b\t'+String(code).padStart(4,'0')+String(body.length).padStart(6,'0')+'00'),body]);
};
const frame = data => {const b=Buffer.from(data);return {code:Number(b.subarray(2,6).toString()),fields:b.subarray(14).toString().split('\f').slice(1,-1)}};
const server=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(r=>server.once('listening',r));
const local=`ws://127.0.0.1:${server.address().port}`;
const connections=new Map(); let serverErrors=[], httpCalls=0, forbiddenNetwork=0;
server.on('connection',(ws,req)=>{
  const id=new URL(req.url,local).pathname.slice(1);
  if(!/^lab\d+$/.test(id)){serverErrors.push('unexpected_session');ws.close();return}
  ws.on('error',e=>serverErrors.push(e.message));
  ws.on('message',raw=>{
    const p=frame(raw);
    if(p.code===16){
      if(p.fields[0]!==`token-${id}`)serverErrors.push('login_token_mismatch');
      ws.send(packet(1,[id,'4|0']));
    }else if(p.code===2){
      if(p.fields[0]!==String(1000+Number(id.slice(3)))||p.fields[1]!==`ticket-${id}`)serverErrors.push('join_identity_mismatch');
      connections.set(id,ws);ws.send(packet(2,[p.fields[0],id,'0','20',']']));
    }
  });
  ws.on('close',()=>{if(connections.get(id)===ws)connections.delete(id)});
});

function realm(id, {mode='online', existing=null}={}){
  let context=existing?.context; const timers=new Map(), sockets=new Set(), errors=[], messages=[], seen=new Set();
  let readyCount=0, closedCount=0, disposed=false, mismatches=0, duplicateCount=0, eventCount=0, latencies=[];
  const makeTimer=(repeat)=>(fn,ms,...args)=>{
    const h=(repeat?setInterval:setTimeout)(()=>{if(!repeat)timers.delete(h);if(!disposed)fn(...args)},ms);
    timers.set(h,repeat);return h;
  };
  const clear=h=>{clearTimeout(h);clearInterval(h);timers.delete(h)};
  if(!context){
    const module={exports:{}};
    context=vm.createContext({module,exports:module.exports,URL,URLSearchParams,TextEncoder,TextDecoder,
      console:{log(){},warn(){},error(){},info(){},debug(){}},
      setTimeout:makeTimer(false),clearTimeout:clear,setInterval:makeTimer(true),clearInterval:clear,
      fetch:async (url,opts)=>{
        httpCalls++;
        const u=new URL(url), form=new URLSearchParams(opts?.body);
        if(u.origin!=='https://openapi.sooplive.com'||u.pathname!=='/broad/access/chatinfo'){
          forbiddenNetwork++;throw Error('network_forbidden:'+u.origin+u.pathname);
        }
        const token=form.get('access_token');
        const account=token?.replace(/^token-/,'');
        assert.match(account,/^lab\d+$/);
        if(mode==='expired')return {status:401,statusText:'Unauthorized',json:async()=>({})};
        if(mode==='offline')return {status:200,json:async()=>({result:-1,msg:'synthetic offline',data:[]})};
        return {status:200,json:async()=>({result:1,data:[{chat_ip:'127.0.0.1',chat_port:8000,id:account,nick:account,broad_no:100+Number(account.slice(3)),chat_no:1000+Number(account.slice(3)),key:`ticket-${account}`,title:'synthetic',cate_name:'test',broad_type:'21'}]})};
      },
      WebSocket:class extends WebSocket {
        constructor(url,protocol){
          const u=new URL(url);
          assert.equal(u.origin,'wss://chat-7f000001.sooplive.com:8001');
          assert.match(u.pathname,/^\/Websocket\/lab\d+$/);
          // SDK requested vendor URL is explicitly mapped to a loopback fixture.
          super(local+'/'+u.pathname.split('/').at(-1),protocol);
          sockets.add(this);this.addEventListener('close',()=>sockets.delete(this));
        }
      }
    });
    compiled.runInContext(context,{timeout:1500});
  }
  const sdk=new context.module.exports('synthetic-client','synthetic-secret');
  sdk.handleReady(()=>readyCount++);
  sdk.handleError(e=>errors.push({code:e?.code||'',message:String(e?.message||e)}));
  sdk.handleChatClosed(()=>closedCount++);
  sdk.handleMessageReceived((action,message)=>{
    if(action==='JOIN')return;
    eventCount++;
    const room=sdk.getRoomInfo();
    if(room.bjId!==id||Number(room.chatNumber)!==1000+Number(id.slice(3)))mismatches++;
    if(message.bjId&&message.bjId!==id)mismatches++;
    if(!String(message.userId).startsWith(`sender-${id}-`))mismatches++;
    const key=action+':'+message.userId;
    if(seen.has(key))duplicateCount++;seen.add(key);
    if(action==='BALLOON_GIFTED'&&message.count!==100)mismatches++;
    if(action==='MESSAGE'){
      const text=String(message.message);
      if(!text.startsWith('룰렛 결과: 꽝 '))mismatches++;
      const sent=Number(text.split(' ').at(-1));latencies.push(Date.now()-sent);
    }
    if(messages.length<4)messages.push({action,...message,room});
  });
  sdk.setAuth(`token-${id}`);
  return {id,context,sdk,errors,messages,timers,sockets,
    get ready(){return readyCount},get closed(){return closedCount},get count(){return eventCount},
    get mismatches(){return mismatches},get duplicates(){return duplicateCount},get latencies(){return latencies},
    async connect(){return sdk.connect()},
    async dispose(){disposed=true;try{sdk.disconnect()}catch{}for(const ws of sockets)ws.close();for(const h of timers.keys())clear(h)}
  };
}
function emitPair(id,seq){
  const ws=connections.get(id);assert.ok(ws,'fixture session ready');
  const sender=`sender-${id}-${seq}`;
  ws.send(packet(5,[`룰렛 결과: 꽝 ${Date.now()}`,sender,'0','','','합성시청자','0|0','0','','','0']));
  ws.send(packet(18,[id,sender,'합성시청자','100','1','0',String(1000+Number(id.slice(3))),'','0','1','']));
}
const sample=()=>({rssMiB:mb(process.memoryUsage().rss),heapUsedMiB:mb(process.memoryUsage().heapUsed),resources:process.getActiveResourcesInfo().reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{})});
const reports=[], functional=[];
try{
  const args=process.argv.slice(2), counts=args[0]==='functional'?[]:args.length?args.map(Number):[2];
  if(args[0]==='functional'){
    for(const mode of ['expired','offline']){
      const s=realm('lab0',{mode});let rejection;
      try{await s.connect()}catch(e){rejection={name:e.name,code:e.code||'',message:e.message}}
      assert.equal(s.ready,0);assert.equal(s.sockets.size,0);assert.ok(rejection);
      functional.push({case:mode,ready:s.ready,errors:s.errors,rejection});await s.dispose();
    }
    const isolated=[realm('lab0'),realm('lab1')];
    for(const s of isolated)await s.connect();await until(()=>isolated.every(s=>s.ready===1));
    for(const s of isolated)emitPair(s.id,'functional');await until(()=>isolated.every(s=>s.count===2));
    let normalized=[];
    for(const s of isolated)for(const [i,msg] of s.messages.entries()){
      const result=classifySoopChatSdkCallback({action:msg.action,message:msg,receivedAt:new Date().toISOString(),connection:{id:`lab-${s.id}`,sequence:i+1,reconnectCount:0}});
      assert.equal(result.kind,'event');normalized.push(result.value.relay.eventType);
    }
    assert.deepEqual(normalized,['chat','donation','chat','donation']);
    const s=isolated[0];connections.get(s.id).terminate();await until(()=>s.closed===1);
    emitPair('lab1','survivor');await until(()=>isolated[1].count===4);assert.equal(isolated[1].mismatches,0);
    functional.push({case:'isolated realm disconnect',otherSessionStillReceiving:true,normalizerTypes:normalized});
    let reconnectFailure;
    try{s.sdk.handleReady(()=>{})}catch(e){reconnectFailure={name:e.name,message:e.message}}
    assert.ok(reconnectFailure);functional.push({case:'reuse closed SDK realm',observedFailure:reconnectFailure,recommendation:'Discard entire realm and instantiate SDK in a fresh realm on every reconnect.'});
    for(const x of isolated)await x.dispose();await until(()=>connections.size===0);
    const a=realm('lab0');await a.connect();await until(()=>a.ready===1);
    const b=realm('lab1',{existing:a});await b.connect();await until(()=>b.ready===1);
    emitPair('lab0','shared');await until(()=>a.count>=2&&b.count>=2);
    assert.ok(a.mismatches+b.mismatches>0);
    functional.push({case:'shared module negative control',crossAccountMismatches:a.mismatches+b.mismatches,aReceived:a.count,bReceived:b.count,recommendation:'Never share one SDK module instance across accounts.'});
    // Negative control only: SDK shares/destroys its emitter. Detach callbacks
    // before closing the intentionally unsafe shared sockets to keep the lab alive.
    for(const ws of a.sockets)ws.onclose=null;
    await a.dispose();await b.dispose();await until(()=>connections.size===0);
    console.log(JSON.stringify(functional));
  }
  for(const count of counts){
    assert.ok(Number.isInteger(count)&&count>0&&count<=500);
    global.gc?.();const baseline=sample();let peak=baseline.rssMiB;
    const monitor=setInterval(()=>{peak=Math.max(peak,sample().rssMiB)},100);
    const loop=monitorEventLoopDelay({resolution:10});loop.enable();
    const start=performance.now(),cpu=process.cpuUsage();let sessions=[];
    try{
      for(let i=0;i<count;i++){
        const session=realm(`lab${i}`);sessions.push(session);await session.connect();
        if(i%25===0)await sleep(0);
      }
      await until(()=>sessions.every(x=>x.ready===1));
      const connectMs=performance.now()-start,connected=sample();
      const rounds=Number(process.env.LAB_ROUNDS||100);
      const cycles=Number(process.env.LAB_CYCLES||3);
      assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=36000,'LAB_ROUNDS must be 1..36000');
      assert.ok(Number.isInteger(cycles)&&cycles>=0&&cycles<=100,'LAB_CYCLES must be 0..100');
      const streamStart=performance.now(), streamCpu=process.cpuUsage();loop.reset();
      for(let r=0;r<rounds;r++){
        for(const s of sessions)emitPair(s.id,r);
        await sleep(100);
      }
      await until(()=>sessions.every(x=>x.count===rounds*2));
      const streamMs=performance.now()-streamStart,streamUsage=process.cpuUsage(streamCpu);
      let received=sessions.reduce((a,s)=>a+s.count,0),mismatches=sessions.reduce((a,s)=>a+s.mismatches,0),duplicates=sessions.reduce((a,s)=>a+s.duplicates,0);
      const lat=sessions.flatMap(s=>s.latencies).sort((a,b)=>a-b);
      assert.equal(mismatches,0);assert.equal(duplicates,0);assert.equal(serverErrors.length,0);assert.equal(sessions.flatMap(s=>s.errors).length,0);
      const streamLoop={p95Ms:loop.percentile(95)/1e6,p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6};
      const reconnect=[];
      for(let cycle=0;cycle<cycles;cycle++){
        const reconnectStart=performance.now();
        for(const ws of connections.values())ws.terminate();
        await until(()=>sessions.every(x=>x.closed===1));
        for(const s of sessions)await s.dispose();
        await until(()=>sessions.every(x=>x.sockets.size===0));
        assert.ok(sessions.every(x=>x.timers.size===0));
        sessions=[];global.gc?.();
        for(let i=0;i<count;i++){const s=realm(`lab${i}`);sessions.push(s);await s.connect();if(i%25===0)await sleep(0)}
        await until(()=>sessions.every(x=>x.ready===1));
        for(const s of sessions)emitPair(s.id,`reconnect-${cycle}`);
        await until(()=>sessions.every(x=>x.count===2));
        assert.ok(sessions.every(x=>x.mismatches===0&&x.duplicates===0&&x.errors.length===0));
        reconnect.push({cycle:cycle+1,ms:performance.now()-reconnectStart,...sample()});
      }
      const totalCpu=process.cpuUsage(cpu);
      reports.push({count,rounds,expectedEvents:count*rounds*2,received,mismatches,duplicates,connectMs,baseline,connected,peakRssMiB:peak,streamMs,eventsPerSecond:received/(streamMs/1000),streamCpuOneCorePercent:(streamUsage.user+streamUsage.system)/1000/streamMs*100,latencyMs:{p50:lat[Math.floor(lat.length*.5)],p95:lat[Math.floor(lat.length*.95)],p99:lat[Math.floor(lat.length*.99)],max:lat.at(-1)},eventLoop:streamLoop,reconnect,totalCpuMs:(totalCpu.user+totalCpu.system)/1000,totalMs:performance.now()-start});
    }finally{for(const s of sessions)await s.dispose();await until(()=>connections.size===0);sessions=[];clearInterval(monitor);loop.disable()}
    global.gc?.();await sleep(100);reports.at(-1).afterCleanup=sample();
    console.log(JSON.stringify(reports.at(-1)));
  }
}finally{
  for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));
  const result={at:new Date().toISOString(),node:process.version,os:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,sdkSha256:createHash('sha256').update(source).digest('hex'),scope:'Synthetic HTTP and loopback WebSocket. SDK unchanged, no production credentials/events. CPU and RSS include fixture server. Not SOOP capacity or DB/outbox performance.',httpCalls,forbiddenNetwork,serverErrors,functional,reports};
  fs.writeFileSync(new URL('../../.local/soop-browserless-lab/result-'+process.version+'-'+process.argv.slice(2).join('-')+(process.env.LAB_CYCLES?'-cycles'+process.env.LAB_CYCLES:'')+'.json',import.meta.url),JSON.stringify(result,null,2));
}
