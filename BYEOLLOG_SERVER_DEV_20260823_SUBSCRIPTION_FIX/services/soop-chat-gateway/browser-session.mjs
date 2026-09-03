import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SDK_URL='https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js';
export const SOOP_SHARED_BROWSER_POLICY=Object.freeze({browserProcesses:1,rendererProcessLimit:8,targetCreationConcurrency:8,sessionsPerShard:16,shardMaxAgeMs:300_000});

let sharedBrowserHost=null,sharedBrowserHostPromise=null;

async function freePort(){return await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(error=>error?reject(error):resolve(address.port))})})}

async function browserExecutable(){
  const candidates=[process.env.SOOP_GATEWAY_BROWSER,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe'),process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Google','Chrome','Application','chrome.exe'),process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'),process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe')].filter(Boolean);
  for(const candidate of candidates){try{await access(candidate);return candidate}catch{}}
  throw Object.assign(new Error('Chrome or Edge was not found'),{code:'browser_not_found'});
}

function pageHtml(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script src="${SDK_URL}"></script></head><body><script>
const chats=new Map();
const emit=(sessionId,value)=>window.byeollogGatewayEmit(JSON.stringify({sessionId,...value}));
window.startByeollogGateway=async(sessionId,config)=>{
  if(!window.SOOP?.ChatSDK)throw new Error('soop_sdk_unavailable');
  if(chats.has(sessionId))throw new Error('soop_session_already_exists');
  const chat=new window.SOOP.ChatSDK(config.clientId,config.clientSecret);
  chats.set(sessionId,chat);
  chat.handleReady(message=>{const room=chat.getRoomInfo();emit(sessionId,{kind:'ready',at:new Date().toISOString(),message,room:{chatNumber:Number(room?.chatNumber||0),bjId:String(room?.bjId||'')}})});
  chat.handleMessageReceived((action,message)=>{
    // Materialize documented SDK fields before JSON serialization. Some SDK
    // builds expose selected values through prototype getters, which otherwise
    // disappear at the browser-to-worker boundary.
    const payload=message&&typeof message==='object'?{...message,
      userId:message.userId,userNickname:message.userNickname,count:message.count,
      message:message.message}:message;
    if(payload&&'imageUrl' in message)payload.imageUrl=message.imageUrl;
    emit(sessionId,{kind:'event',at:new Date().toISOString(),action:String(action||''),message:payload})
  });
  chat.handleError((code,message)=>emit(sessionId,{kind:'sdk_error',at:new Date().toISOString(),code:String(code?.code||code||''),message:String(message?.message||message||code?.message||'')}));
  chat.handleChatClosed(()=>emit(sessionId,{kind:'closed',at:new Date().toISOString()}));
  try{chat.setAuth(config.accessToken);await chat.connect()}
  catch(error){chats.delete(sessionId);throw error}
  emit(sessionId,{kind:'connect_started',at:new Date().toISOString()});return true;
};
window.stopByeollogGateway=sessionId=>{const chat=chats.get(sessionId);chats.delete(sessionId);try{chat?.disconnect()}catch{}return true};
window.createByeollogProbeSessions=count=>{window.__byeollogProbeSessions=Array.from({length:count},()=>new window.SOOP.ChatSDK('probe-client','probe-secret'));return window.__byeollogProbeSessions.length};
</script></body></html>`}

async function localPage(){
  const port=await freePort(),html=pageHtml();
  const server=createServer((req,res)=>{if(req.url!=='/'){res.writeHead(404);return res.end()}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline' ${new URL(SDK_URL).origin}; connect-src https: wss:; base-uri 'none'; frame-ancestors 'none'`,'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(html)});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${port}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function waitJson(url,timeoutMs=15_000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{const response=await fetch(url,{cache:'no-store'});if(response.ok)return await response.json()}catch{}await new Promise(resolve=>setTimeout(resolve,150))}throw Object.assign(new Error('Chrome DevTools timeout'),{code:'browser_debug_timeout'})}

function cdpClient(url,onEvent,onClosed=()=>{}){
  const socket=new WebSocket(url);let id=0;const pending=new Map();
  const opened=new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Object.assign(new Error('Chrome DevTools connection failed'),{code:'browser_debug_failed'})),{once:true})});
  socket.addEventListener('message',event=>{let message;try{message=JSON.parse(event.data)}catch{return}if(message.id){const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message||'CDP failed')):waiter.resolve(message.result||{});return}onEvent?.(message)});
  socket.addEventListener('close',()=>{for(const waiter of pending.values())waiter.reject(new Error('Chrome DevTools closed'));pending.clear();onClosed()});
  return {async send(method,params={}){await opened;const messageId=++id;const result=new Promise((resolve,reject)=>pending.set(messageId,{resolve,reject}));socket.send(JSON.stringify({id:messageId,method,params}));return await result},close(){socket.close()}};
}

function configuredRendererLimit(){
  const value=Math.trunc(Number(process.env.SOOP_GATEWAY_RENDERER_PROCESS_LIMIT));
  return Number.isSafeInteger(value)&&value>=2&&value<=32
    ?value
    :SOOP_SHARED_BROWSER_POLICY.rendererProcessLimit;
}

function configuredSessionsPerShard(){
  const value=Math.trunc(Number(process.env.SOOP_GATEWAY_SESSIONS_PER_SHARD));
  return Number.isSafeInteger(value)&&value>=1&&value<=50
    ?value
    :SOOP_SHARED_BROWSER_POLICY.sessionsPerShard;
}

function configuredShardMaxAgeMs(){
  const value=Math.trunc(Number(process.env.SOOP_GATEWAY_SHARD_MAX_AGE_MS));
  return Number.isSafeInteger(value)&&value>=60_000&&value<=3_600_000
    ?value
    :SOOP_SHARED_BROWSER_POLICY.shardMaxAgeMs;
}

export function soopBrowserShardExpired(createdAt,now=Date.now(),maxAgeMs=configuredShardMaxAgeMs()){
  const created=Number(createdAt),instant=Number(now),maximum=Number(maxAgeMs);
  return Number.isFinite(created)&&Number.isFinite(instant)&&Number.isFinite(maximum)&&maximum>0&&instant-created>=maximum;
}

export function soopBrowserRuntimePolicy(){
  return Object.freeze({
    browserProcesses:SOOP_SHARED_BROWSER_POLICY.browserProcesses,
    rendererProcessLimit:configuredRendererLimit(),
    sessionsPerShard:configuredSessionsPerShard(),
    shardMaxAgeMs:configuredShardMaxAgeMs()
  });
}

export function soopBrowserShardCount(sessionCount,sessionsPerShard=configuredSessionsPerShard()){
  const count=Math.trunc(Number(sessionCount)),capacity=Math.trunc(Number(sessionsPerShard));
  if(!Number.isSafeInteger(count)||count<0)throw new Error('Session count must be zero or greater');
  if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('Shard capacity must be one or greater');
  return count===0?0:Math.ceil(count/capacity);
}

function concurrencyGate(limit){
  let active=0;const waiting=[];
  return async task=>{
    if(active>=limit)await new Promise(resolve=>waiting.push(resolve));
    active+=1;
    try{return await task()}
    finally{active-=1;waiting.shift()?.()}
  };
}

async function createSharedBrowserHost(){
  const executable=await browserExecutable(),debugPort=await freePort(),profile=await mkdtemp(join(tmpdir(),'byeollog-soop-gateway-')),page=await localPage();
  const chromeArguments=['--headless=new',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-dev-shm-usage','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-features=CalculateNativeWinOcclusion',`--renderer-process-limit=${configuredRendererLimit()}`];
  if(process.env.SOOP_GATEWAY_CHROME_NO_SANDBOX==='true')chromeArguments.push('--no-sandbox');
  chromeArguments.push('about:blank');
  const chrome=spawn(executable,chromeArguments,{stdio:'ignore',windowsHide:true});
  const host={chrome,debugPort,profile,page,alive:true,targets:new Set(),shards:new Set(),closed:null};
  const exited=new Promise(resolve=>chrome.once('exit',resolve));
  host.closed=exited;
  chrome.once('exit',()=>{
    host.alive=false;
    if(sharedBrowserHost===host)sharedBrowserHost=null;
    sharedBrowserHostPromise=null;
    void page.close().catch(()=>{});
    void rm(profile,{recursive:true,force:true}).catch(()=>{});
  });
  try{await waitJson(`http://127.0.0.1:${debugPort}/json/version`)}
  catch(error){try{chrome.kill()}catch{}await page.close().catch(()=>{});await rm(profile,{recursive:true,force:true}).catch(()=>{});throw error}
  const createTargetLimited=concurrencyGate(SOOP_SHARED_BROWSER_POLICY.targetCreationConcurrency);
  host.createTarget=async()=>await createTargetLimited(async()=>{
    if(!host.alive)throw Object.assign(new Error('Shared Chrome host is unavailable'),{code:'browser_host_closed'});
    const response=await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(page.url)}`,{method:'PUT'});
    if(!response.ok)throw new Error('Chrome tab creation failed');
    const target=await response.json();
    if(!target?.id||!target?.webSocketDebuggerUrl)throw new Error('Chrome tab metadata is invalid');
    host.targets.add(target.id);
    return target;
  });
  host.closeTarget=async targetId=>{
    host.targets.delete(targetId);
    if(!host.alive)return;
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${encodeURIComponent(targetId)}`,{method:'GET'}).catch(()=>{});
  };
  let shardLock=Promise.resolve();
  host.withShardLock=async task=>{
    const previous=shardLock;let release;
    shardLock=new Promise(resolve=>{release=resolve});
    await previous;
    try{return await task()}finally{release()}
  };
  host.acquireShardSession=async session=>await host.withShardLock(async()=>{
    if(!host.alive)throw Object.assign(new Error('Shared Chrome host is unavailable'),{code:'browser_host_closed'});
    const now=Date.now();
    let shard=[...host.shards].find(candidate=>candidate.alive
      &&candidate.sessions.size<candidate.capacity
      &&!soopBrowserShardExpired(candidate.createdAt,now));
    if(!shard)shard=await createSharedBrowserShard(host);
    // Keep live workspaces untouched. Once a replacement is ready, only empty
    // expired shards are retired so offline polling periodically reloads the
    // official SDK and its broadcast-discovery state.
    const expiredEmpty=[...host.shards].filter(candidate=>candidate!==shard&&candidate.alive
      &&candidate.sessions.size===0&&soopBrowserShardExpired(candidate.createdAt,now));
    await Promise.allSettled(expiredEmpty.map(candidate=>candidate.close()));
    const sessionId=randomUUID();
    shard.sessions.set(sessionId,session);
    return {shard,sessionId};
  });
  host.close=async()=>{
    if(!host.alive)return;
    host.alive=false;
    for(const shard of [...host.shards])await shard.close();
    for(const targetId of [...host.targets])await host.closeTarget(targetId);
    try{chrome.kill()}catch{}
    await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2_000))]);
    await page.close().catch(()=>{});
    await rm(profile,{recursive:true,force:true}).catch(()=>{});
  };
  return host;
}

async function createSharedBrowserShard(host){
  const target=await host.createTarget();let shard=null,cdp=null;
  try{
    shard={target,cdp:null,alive:true,createdAt:Date.now(),capacity:configuredSessionsPerShard(),sessions:new Map(),pageObjectId:null};
    cdp=cdpClient(target.webSocketDebuggerUrl,message=>{
      if(message.method!=='Runtime.bindingCalled'||message.params?.name!=='byeollogGatewayEmit')return;
      try{
        const event=JSON.parse(message.params.payload),session=shard.sessions.get(String(event.sessionId||''));
        session?.handle(event);
      }catch{}
    },()=>{
      if(!shard?.alive)return;
      shard.alive=false;host.shards.delete(shard);
      for(const session of shard.sessions.values())session.finish('browser_closed');
      shard.sessions.clear();
    });
    shard.cdp=cdp;
    await cdp.send('Runtime.enable');await cdp.send('Runtime.addBinding',{name:'byeollogGatewayEmit'});
    const deadline=Date.now()+15_000;let sdkReady=false;
    while(Date.now()<deadline){
      const evaluated=await cdp.send('Runtime.evaluate',{expression:'Boolean(window.SOOP?.ChatSDK&&window.startByeollogGateway&&window.stopByeollogGateway)',returnByValue:true});
      if(evaluated.result?.value){sdkReady=true;break}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!sdkReady)throw Object.assign(new Error('SOOP SDK shard did not become ready'),{code:'sdk_page_not_ready'});
    const pageWindow=await cdp.send('Runtime.evaluate',{expression:'window',returnByValue:false});
    shard.pageObjectId=pageWindow.result?.objectId;
    if(!shard.pageObjectId)throw Object.assign(new Error('SOOP SDK shard context is unavailable'),{code:'sdk_page_context_missing'});
    shard.start=async(sessionId,config)=>await cdp.send('Runtime.callFunctionOn',{functionDeclaration:'async function(sessionId,config){return await this.startByeollogGateway(sessionId,config)}',objectId:shard.pageObjectId,arguments:[{value:sessionId},{value:config}],awaitPromise:true,returnByValue:true});
    shard.stop=async sessionId=>{
      shard.sessions.delete(sessionId);
      if(!shard.alive)return;
      await cdp.send('Runtime.callFunctionOn',{functionDeclaration:'function(sessionId){return this.stopByeollogGateway(sessionId)}',objectId:shard.pageObjectId,arguments:[{value:sessionId}],returnByValue:true}).catch(()=>{});
      if(shard.sessions.size===0&&soopBrowserShardExpired(shard.createdAt))await shard.close();
    };
    shard.createProbeSessions=async count=>await cdp.send('Runtime.callFunctionOn',{functionDeclaration:'function(count){return this.createByeollogProbeSessions(count)}',objectId:shard.pageObjectId,arguments:[{value:count}],returnByValue:true});
    shard.close=async()=>{
      if(!shard.alive)return;
      shard.alive=false;host.shards.delete(shard);
      for(const session of shard.sessions.values())session.finish('browser_closed');
      shard.sessions.clear();
      try{cdp.close()}catch{}
      await host.closeTarget(target.id);
    };
    host.shards.add(shard);
    return shard;
  }catch(error){
    try{cdp?.close()}catch{}
    await host.closeTarget(target.id);
    throw error;
  }
}

async function browserHost(){
  if(sharedBrowserHost?.alive)return sharedBrowserHost;
  if(!sharedBrowserHostPromise){
    sharedBrowserHostPromise=createSharedBrowserHost().then(host=>(sharedBrowserHost=host)).catch(error=>{sharedBrowserHostPromise=null;throw error});
  }
  return await sharedBrowserHostPromise;
}

export async function closeSoopBrowserHost(){
  const host=sharedBrowserHost||await sharedBrowserHostPromise?.catch(()=>null);
  sharedBrowserHost=null;sharedBrowserHostPromise=null;
  await host?.close?.();
}

// Opens real SDK pages without authenticating them. This is intentionally
// separate from the live worker so capacity can be measured without touching
// streamer tokens or producing events.
export async function openSoopSharedBrowserProbeTargets(count){
  const targetCount=Math.trunc(Number(count));
  if(!Number.isSafeInteger(targetCount)||targetCount<1||targetCount>500)throw new Error('Probe target count must be between 1 and 500');
  const host=await browserHost(),targets=[];
  try{
    for(let offset=0;offset<targetCount;offset+=10){
      const batch=await Promise.all(Array.from({length:Math.min(10,targetCount-offset)},()=>host.createTarget()));
      targets.push(...batch);
    }
  }catch(error){
    await Promise.allSettled(targets.map(target=>host.closeTarget(target.id)));
    throw error;
  }
  return {
    browserPid:host.chrome.pid,
    targetCount:targets.length,
    rendererProcessLimit:configuredRendererLimit(),
    close:async()=>await Promise.allSettled(targets.map(target=>host.closeTarget(target.id)))
  };
}

// Measures the shard model without authenticating streamer sessions. Each
// shard loads the official SDK once and creates the same number of ChatSDK
// objects that a live shard would own, but it never supplies tokens or opens
// live sockets.
export async function openSoopSharedBrowserProbeSessions(count){
  const targetCount=Math.trunc(Number(count));
  if(!Number.isSafeInteger(targetCount)||targetCount<1||targetCount>500)throw new Error('Probe session count must be between 1 and 500');
  const host=await browserHost(),capacity=configuredSessionsPerShard(),shards=[];
  try{
    let remaining=targetCount;
    while(remaining>0){
      const shard=await createSharedBrowserShard(host),sessions=Math.min(capacity,remaining);
      const created=await shard.createProbeSessions(sessions);
      if(created.exceptionDetails||Number(created.result?.value)!==sessions)throw new Error('SOOP SDK probe sessions were not created');
      shards.push(shard);remaining-=sessions;
    }
  }catch(error){
    await Promise.allSettled(shards.map(shard=>shard.close()));
    throw error;
  }
  return {
    browserPid:host.chrome.pid,targetCount,shardCount:shards.length,sessionsPerShard:capacity,
    rendererProcessLimit:configuredRendererLimit(),
    close:async()=>await Promise.allSettled(shards.map(shard=>shard.close()))
  };
}

export async function runSoopBrowserSession({clientId,clientSecret,accessToken,signal,onEvent=()=>{},onState=()=>{}}={}){
  const host=await browserHost();
  if(signal?.aborted)return {reason:'aborted',ready:false,errorCode:null,errorMessage:null};
  let settled=false,ready=false,lastErrorCode=null,lastErrorMessage=null,shard=null,sessionId=null;
  let finish;const finished=new Promise(resolve=>{finish=reason=>{if(settled)return;settled=true;resolve(reason)}});
  const abort=()=>finish('aborted');signal?.addEventListener('abort',abort,{once:true});
  try{
    const session={finish,handle:event=>{
      try{
        if(event.kind==='ready'){ready=true;onState({state:'connected',at:event.at,message:event.message,room:event.room})}
        else if(event.kind==='connect_started')onState({state:'connecting',at:event.at,room:event.room});
        else if(event.kind==='event')onEvent(event);
        else if(event.kind==='sdk_error'){
          lastErrorCode=String(event.code||'sdk_error').slice(0,120);
          lastErrorMessage=String(event.message||'').slice(0,500);
          onState({state:'error',at:event.at,code:lastErrorCode,message:lastErrorMessage});finish('sdk_error')
        }
        else if(event.kind==='closed'){onState({state:'closed',at:event.at});finish('closed')}
      }catch{}
    }};
    ({shard,sessionId}=await host.acquireShardSession(session));
    const started=await shard.start(sessionId,{clientId,clientSecret,accessToken});
    if(started.exceptionDetails)throw Object.assign(new Error(started.exceptionDetails.exception?.description||started.exceptionDetails.text||'SOOP SDK connection failed'),{code:'sdk_connect_failed'});
    const result=await finished;
    return {reason:result,ready,errorCode:lastErrorCode,errorMessage:lastErrorMessage};
  }finally{
    signal?.removeEventListener('abort',abort);
    if(shard&&sessionId)await shard.stop(sessionId).catch(()=>{});
  }
}
