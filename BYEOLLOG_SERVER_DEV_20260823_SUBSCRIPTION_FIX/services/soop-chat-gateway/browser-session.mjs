import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SDK_URL='https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js';

async function freePort(){return await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(error=>error?reject(error):resolve(address.port))})})}

async function browserExecutable(){
  const candidates=[process.env.SOOP_GATEWAY_BROWSER,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe'),process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Google','Chrome','Application','chrome.exe'),process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'),process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe')].filter(Boolean);
  for(const candidate of candidates){try{await access(candidate);return candidate}catch{}}
  throw Object.assign(new Error('Chrome or Edge was not found'),{code:'browser_not_found'});
}

function pageHtml(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script src="${SDK_URL}"></script></head><body><script>
const emit=value=>window.byeollogGatewayEmit(JSON.stringify(value));
window.startByeollogGateway=async config=>{
  if(!window.SOOP?.ChatSDK)throw new Error('soop_sdk_unavailable');
  const chat=new window.SOOP.ChatSDK(config.clientId,config.clientSecret);
  chat.handleReady(message=>{const room=chat.getRoomInfo();emit({kind:'ready',at:new Date().toISOString(),message,room:{chatNumber:Number(room?.chatNumber||0),bjId:String(room?.bjId||'')}})});
  chat.handleMessageReceived((action,message)=>{
    // Materialize documented SDK fields before JSON serialization. Some SDK
    // builds expose selected values through prototype getters, which otherwise
    // disappear at the browser-to-worker boundary.
    const payload=message&&typeof message==='object'?{...message,
      userId:message.userId,userNickname:message.userNickname,count:message.count,
      message:message.message}:message;
    if(payload&&'imageUrl' in message)payload.imageUrl=message.imageUrl;
    emit({kind:'event',at:new Date().toISOString(),action:String(action||''),message:payload})
  });
  chat.handleError((code,message)=>emit({kind:'sdk_error',at:new Date().toISOString(),code:String(code?.code||code||''),message:String(message?.message||message||code?.message||'')}));
  chat.handleChatClosed(()=>emit({kind:'closed',at:new Date().toISOString()}));
  chat.setAuth(config.accessToken);await chat.connect();window.__byeollogChat=chat;
  emit({kind:'connect_started',at:new Date().toISOString()});return true;
};
window.stopByeollogGateway=()=>{try{window.__byeollogChat?.disconnect()}catch{}return true};
</script></body></html>`}

async function localPage(){
  const port=await freePort(),html=pageHtml();
  const server=createServer((req,res)=>{if(req.url!=='/'){res.writeHead(404);return res.end()}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline' ${new URL(SDK_URL).origin}; connect-src https: wss:; base-uri 'none'; frame-ancestors 'none'`,'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(html)});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${port}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function waitJson(url,timeoutMs=15_000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{const response=await fetch(url,{cache:'no-store'});if(response.ok)return await response.json()}catch{}await new Promise(resolve=>setTimeout(resolve,150))}throw Object.assign(new Error('Chrome DevTools timeout'),{code:'browser_debug_timeout'})}

function cdpClient(url,onEvent){
  const socket=new WebSocket(url);let id=0;const pending=new Map();
  const opened=new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Object.assign(new Error('Chrome DevTools connection failed'),{code:'browser_debug_failed'})),{once:true})});
  socket.addEventListener('message',event=>{let message;try{message=JSON.parse(event.data)}catch{return}if(message.id){const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message||'CDP failed')):waiter.resolve(message.result||{});return}onEvent?.(message)});
  socket.addEventListener('close',()=>{for(const waiter of pending.values())waiter.reject(new Error('Chrome DevTools closed'));pending.clear()});
  return {async send(method,params={}){await opened;const messageId=++id;const result=new Promise((resolve,reject)=>pending.set(messageId,{resolve,reject}));socket.send(JSON.stringify({id:messageId,method,params}));return await result},close(){socket.close()}};
}

export async function runSoopBrowserSession({clientId,clientSecret,accessToken,signal,onEvent=()=>{},onState=()=>{}}={}){
  const executable=await browserExecutable(),debugPort=await freePort(),profile=await mkdtemp(join(tmpdir(),'byeollog-soop-gateway-')),page=await localPage();
  const chromeArguments=['--headless=new',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-dev-shm-usage'];
  if(process.env.SOOP_GATEWAY_CHROME_NO_SANDBOX==='true')chromeArguments.push('--no-sandbox');
  chromeArguments.push('about:blank');
  const chrome=spawn(executable,chromeArguments,{stdio:'ignore',windowsHide:true});
  let cdp,settled=false,ready=false,lastErrorCode=null,lastErrorMessage=null;
  let finish;const finished=new Promise(resolve=>{finish=reason=>{if(settled)return;settled=true;resolve(reason)}});
  const abort=()=>finish('aborted');signal?.addEventListener('abort',abort,{once:true});
  try{
    await waitJson(`http://127.0.0.1:${debugPort}/json/version`);
    const targetResponse=await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(page.url)}`,{method:'PUT'});if(!targetResponse.ok)throw new Error('Chrome tab creation failed');
    const target=await targetResponse.json();
    cdp=cdpClient(target.webSocketDebuggerUrl,message=>{
      if(message.method!=='Runtime.bindingCalled'||message.params?.name!=='byeollogGatewayEmit')return;
      try{
        const event=JSON.parse(message.params.payload);
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
    });
    await cdp.send('Runtime.enable');await cdp.send('Runtime.addBinding',{name:'byeollogGatewayEmit'});
    const deadline=Date.now()+15_000;let ready=false;
    while(Date.now()<deadline){const evaluated=await cdp.send('Runtime.evaluate',{expression:'Boolean(window.SOOP?.ChatSDK&&window.startByeollogGateway)',returnByValue:true});if(evaluated.result?.value){ready=true;break}await new Promise(resolve=>setTimeout(resolve,150))}
    if(!ready)throw Object.assign(new Error('SOOP SDK page did not become ready'),{code:'sdk_page_not_ready'});
    const pageWindow=await cdp.send('Runtime.evaluate',{expression:'window',returnByValue:false});
    const pageObjectId=pageWindow.result?.objectId;
    if(!pageObjectId)throw Object.assign(new Error('SOOP SDK page context is unavailable'),{code:'sdk_page_context_missing'});
    const started=await cdp.send('Runtime.callFunctionOn',{functionDeclaration:'async function(config){return await this.startByeollogGateway(config)}',objectId:pageObjectId,arguments:[{value:{clientId,clientSecret,accessToken}}],awaitPromise:true,returnByValue:true});
    if(started.exceptionDetails)throw Object.assign(new Error(started.exceptionDetails.exception?.description||started.exceptionDetails.text||'SOOP SDK connection failed'),{code:'sdk_connect_failed'});
    const result=await finished;
    return {reason:result,ready,errorCode:lastErrorCode,errorMessage:lastErrorMessage};
  }finally{
    signal?.removeEventListener('abort',abort);
    try{await cdp?.send('Runtime.evaluate',{expression:'window.stopByeollogGateway?.()',returnByValue:true})}catch{}
    try{cdp?.close()}catch{}try{chrome.kill()}catch{}await page.close().catch(()=>{});await rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
}
