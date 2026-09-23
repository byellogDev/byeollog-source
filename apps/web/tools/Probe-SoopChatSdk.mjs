import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {sb} from '../lib/supabase-rest.js';
import {refreshSoopConnection} from '../lib/soop-oauth.js';

const SDK_URL='https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js';
const DEFAULT_DURATION_SECONDS=120;

function option(name,fallback=''){
  const index=process.argv.indexOf(name);
  return index>=0&&process.argv[index+1]?String(process.argv[index+1]).trim():fallback;
}

function positiveInteger(value,fallback){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:fallback;
}

function browserPath(){
  const candidates=[
    process.env.SOOP_PROBE_BROWSER,
    process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe'),
    process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Google','Chrome','Application','chrome.exe'),
    process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),
    process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'),
    process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe')
  ].filter(Boolean);
  return candidates.find(path=>{
    try{return requireStat(path)}catch{return false}
  })||'';
}

function requireStat(path){
  // Synchronous existence checks are intentionally avoided; opening the browser
  // is the authoritative check and keeps this probe dependency-free.
  return path;
}

async function firstReachableBrowser(){
  const candidates=[
    process.env.SOOP_PROBE_BROWSER,
    process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe'),
    process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Google','Chrome','Application','chrome.exe'),
    process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),
    process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'),
    process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe')
  ].filter(Boolean);
  const {access}=await import('node:fs/promises');
  for(const candidate of candidates){
    try{await access(candidate);return candidate}catch{}
  }
  throw new Error('Chrome 또는 Edge 실행 파일을 찾지 못했습니다.');
}

async function freePort(){
  return await new Promise((resolve,reject)=>{
    const server=createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      server.close(error=>error?reject(error):resolve(address.port));
    });
  });
}

function probeHtml(){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script src="${SDK_URL}"></script></head><body><script>
  const emit=value=>window.byeollogProbeEmit(JSON.stringify(value));
  const safeMessage=(action,message)=>{
    if(!message||typeof message!=='object')return {};
    if(action==='MESSAGE'||action==='MANAGER_MESSAGE')return {
      userId:String(message.userId||''),userNickname:String(message.userNickname||''),message:String(message.message||'')
    };
    if(action==='BALLOON_GIFTED')return {
      bjId:String(message.bjId||''),userId:String(message.userId||''),userNickname:String(message.userNickname||''),count:Number(message.count||0)
    };
    if(action==='LOGIN'||action==='JOIN')return {
      userId:String(message.userId||''),userNickname:String(message.userNickname||'')
    };
    return {};
  };
  window.startByeollogSoopProbe=async config=>{
    if(!window.SOOP?.ChatSDK)throw new Error('SOOP ChatSDK를 불러오지 못했습니다.');
    const chat=new window.SOOP.ChatSDK(config.clientId,config.clientSecret);
    chat.handleReady(()=>{const room=chat.getRoomInfo();emit({kind:'connected',at:new Date().toISOString(),connected:true,room:{chatNumber:Number(room?.chatNumber||0),bjId:String(room?.bjId||'')}})});
    chat.handleMessageReceived((action,message)=>emit({kind:'event',at:new Date().toISOString(),action:String(action||''),message:safeMessage(action,message)}));
    chat.handleError((code,message)=>emit({kind:'sdk_error',at:new Date().toISOString(),code:String(code?.code||code||''),message:String(message?.message||message||code?.message||'')}));
    chat.handleChatClosed(()=>emit({kind:'closed',at:new Date().toISOString()}));
    chat.setAuth(config.accessToken);
    await chat.connect();
    window.__byeollogChat=chat;
    return true;
  };
  </script></body></html>`;
}

async function localPage(){
  const port=await freePort();
  const html=probeHtml();
  const server=createServer((req,res)=>{
    if(req.url!=='/'){
      res.writeHead(404,{'Content-Type':'text/plain;charset=utf-8','Cache-Control':'no-store'});return res.end('Not found');
    }
    res.writeHead(200,{
      'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline' ${new URL(SDK_URL).origin}; connect-src https: wss:; base-uri 'none'; frame-ancestors 'none'`,
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'
    });
    res.end(html);
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${port}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function waitForJson(url,{timeoutMs=15_000}={}){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{
      const response=await fetch(url,{cache:'no-store'});
      if(response.ok)return await response.json();
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`Chrome DevTools 연결 시간 초과: ${url}`);
}

function cdpClient(url,onEvent){
  const socket=new WebSocket(url);
  let id=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    let message;
    try{message=JSON.parse(event.data)}catch{return}
    if(message.id){
      const waiter=pending.get(message.id);if(!waiter)return;
      pending.delete(message.id);
      if(message.error)waiter.reject(new Error(message.error.message||'CDP command failed'));
      else waiter.resolve(message.result||{});
      return;
    }
    onEvent?.(message);
  });
  socket.addEventListener('close',()=>{
    for(const waiter of pending.values())waiter.reject(new Error('Chrome DevTools 연결이 종료되었습니다.'));
    pending.clear();
  });
  const opened=new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',()=>reject(new Error('Chrome DevTools에 연결하지 못했습니다.')),{once:true});
  });
  return {
    async send(method,params={}){
      await opened;
      const messageId=++id;
      const result=new Promise((resolve,reject)=>pending.set(messageId,{resolve,reject}));
      socket.send(JSON.stringify({id:messageId,method,params}));
      return await result;
    },
    close(){socket.close()}
  };
}

async function connection(){
  const requested=option('--workspace');
  const rows=await sb('byeollog_soop_connections','?select=workspace_id,status&status=eq.connected&order=updated_at.desc&limit=3');
  const selected=requested
    ? rows.find(row=>String(row.workspace_id)===requested)
    : rows.length===1?rows[0]:null;
  if(!selected){
    if(!rows.length)throw new Error('연결된 SOOP 계정이 없습니다. 먼저 별록 대시보드에서 SOOP 인증을 완료해주세요.');
    throw new Error('연결된 SOOP 계정이 여러 개입니다. --workspace <UUID>를 지정해주세요.');
  }
  const token=await refreshSoopConnection(selected.workspace_id);
  return {workspaceId:selected.workspace_id,accessToken:token.accessToken,expiresAt:token.expiresAt,refreshed:token.refreshed};
}

async function main(){
  const durationSeconds=positiveInteger(option('--duration'),DEFAULT_DURATION_SECONDS);
  const clientId=String(process.env.SOOP_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.SOOP_CLIENT_SECRET||'').trim();
  if(!clientId||!clientSecret)throw new Error('SOOP Client ID/Secret 환경변수가 없습니다.');
  const linked=await connection();
  const executable=await firstReachableBrowser();
  const debugPort=await freePort();
  const profile=await mkdtemp(join(tmpdir(),'byeollog-soop-probe-'));
  const page=await localPage();
  const chrome=spawn(executable,[
    '--headless=new',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,
    '--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'
  ],{stdio:'ignore',windowsHide:true});
  let cdp;
  let receivedChat=false;
  try{
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const targetResponse=await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(page.url)}`,{method:'PUT'});
    if(!targetResponse.ok)throw new Error(`Chrome 탭 생성 실패: HTTP ${targetResponse.status}`);
    const target=await targetResponse.json();
    cdp=cdpClient(target.webSocketDebuggerUrl,message=>{
      if(message.method!=='Runtime.bindingCalled'||message.params?.name!=='byeollogProbeEmit')return;
      try{
        const event=JSON.parse(message.params.payload);
        if(event.action==='MESSAGE')receivedChat=true;
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }catch{}
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding',{name:'byeollogProbeEmit'});
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){
      const ready=await cdp.send('Runtime.evaluate',{expression:'Boolean(window.SOOP?.ChatSDK&&window.startByeollogSoopProbe)',returnByValue:true});
      if(ready.result?.value)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    process.stdout.write(`${JSON.stringify({kind:'probe_started',workspaceId:linked.workspaceId,tokenRefreshed:linked.refreshed,expiresAt:linked.expiresAt,durationSeconds})}\n`);
    const pageWindow=await cdp.send('Runtime.evaluate',{expression:'window',returnByValue:false});
    const pageObjectId=pageWindow.result?.objectId;
    if(!pageObjectId)throw new Error('SOOP SDK 페이지 실행 컨텍스트를 찾지 못했습니다.');
    const started=await cdp.send('Runtime.callFunctionOn',{
      functionDeclaration:'async function(config){return await this.startByeollogSoopProbe(config)}',
      objectId:pageObjectId,
      arguments:[{value:{clientId,clientSecret,accessToken:linked.accessToken}}],
      awaitPromise:true,returnByValue:true
    });
    if(started.exceptionDetails)throw new Error(started.exceptionDetails.exception?.description||started.exceptionDetails.text||'SOOP SDK 연결 실패');
    await new Promise(resolve=>setTimeout(resolve,durationSeconds*1000));
    process.stdout.write(`${JSON.stringify({kind:'probe_finished',receivedChat})}\n`);
    process.exitCode=receivedChat?0:2;
  }finally{
    try{cdp?.close()}catch{}
    try{chrome.kill()}catch{}
    await page.close().catch(()=>{});
    await rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
}

main().catch(error=>{
  const message=String(error?.message||error).replace(/(?:access|refresh)[_-]?token[^\s]*/gi,'[token-redacted]');
  console.error(JSON.stringify({kind:'probe_failed',message}));
  process.exitCode=1;
});
