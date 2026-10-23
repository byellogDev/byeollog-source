// Real Chromium + local synthetic SDK. No credentials or external sockets.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(process.argv[2]||'services/soop-gateway');
const browser=pathToFileURL(resolve(root,'services/soop-chat-gateway/browser-session.mjs'));
let pages=0;
const sdk=`let emitter={};let callbacks={};
window.SOOP={ChatSDK:function(mode){
const bind=(k,f)=>{if(!emitter)throw new TypeError("Cannot read properties of null (reading 'on')");callbacks[k]=f};
const close=()=>{if(emitter){callbacks.closed?.();emitter=null}};
return {handleReady:f=>bind('ready',f),handleError:f=>bind('error',f),handleMessageReceived:f=>bind('message',f),handleChatClosed:f=>bind('closed',f),setAuth(){},getRoomInfo(){return{chatNumber:1,bjId:mode==='mismatch'?'other':mode==='suffix'?'fixture(2)':mode==='suffix-mismatch'?'other(2)':mode==='suffix-invalid'?'fixture(2)other':'fixture'}},
 connect(){if(mode==='throw')throw Error('fixture_start_failure');if(mode==='offline'){setTimeout(()=>callbacks.error?.('broadcast_offline','offline'),10);return}if(mode==='timeout')return;
 setTimeout(()=>{callbacks.ready?.();if(mode==='close')setTimeout(close,30);if(mode==='error')setTimeout(()=>callbacks.error?.('fixture_error','error'),30)},10)},disconnect:close};}};
`;
const server=createServer((req,res)=>{if(req.url!=='/sdk.js'){res.writeHead(404);return res.end()}pages++;res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(sdk)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/sdk.js`;
let source=await readFile(browser,'utf8');
source=source.replace("const SDK_URL='https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js';",`const SDK_URL=${JSON.stringify(url)};`)
 .replace("from './cdp-client.mjs'",`from '${new URL('./cdp-client.mjs',browser).href}'`)
 .replace("from '../../lib/soop-room-identity.js'",`from '${new URL('../../lib/soop-room-identity.js',browser).href}'`);
source+=`\nexport async function inspectFixtureResources(){const host=await browserHost();const c=await host.browserCdp.send('Target.getBrowserContexts');return {targets:host.targets.size,shards:host.shards.size,contexts:c.browserContextIds.length}}`;
source+=`\nexport async function inspectFixtureIsolation(){const host=await browserHost();const shards=[];try{shards.push(await createSharedBrowserShard(host));shards.push(await createSharedBrowserShard(host));await shards[0].cdp.send('Runtime.evaluate',{expression:"localStorage.setItem('fixture','private');document.cookie='fixture=private; path=/';true",returnByValue:true});const result=await shards[1].cdp.send('Runtime.evaluate',{expression:"({local:localStorage.getItem('fixture'),cookie:document.cookie})",returnByValue:true});return {isolated:result.result?.value?.local===null&&!result.result?.value?.cookie?.includes('fixture=private'),contextsDistinct:shards[0].target.browserContextId!==shards[1].target.browserContextId}}finally{await Promise.allSettled(shards.map(s=>s.close()))}}`;
const gateway=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const results=[];
process.env.SOOP_GATEWAY_CONNECT_TIMEOUT_MS='10000';
async function session(mode){const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),14000);try{return await gateway.runSoopBrowserSession({clientId:mode,clientSecret:'fixture',accessToken:'fixture',expectedBroadcasterId:'fixture',signal:ac.signal,onState:e=>{if(['abort','suffix'].includes(mode)&&e.state==='connected')ac.abort()}})}finally{clearTimeout(timer)}}
try{
 for(const mode of ['close','close','error','close','throw','close','offline','close','mismatch','close','abort','close','timeout','close','suffix','suffix-mismatch','suffix-invalid']){
  const before=pages;const result=await session(mode);assert.equal(pages,before+1,`${mode}: each session requires a fresh SDK page`);
  if(['close','error','abort','suffix'].includes(mode))assert.equal(result.ready,true,mode);
  else assert.equal(result.ready,false,mode);
  assert.deepEqual(await gateway.inspectFixtureResources(),{targets:0,shards:0,contexts:0},`${mode}: session resources must be released`);
  results.push({mode,reason:result.reason,ready:result.ready});
 }
 const isolation=await gateway.inspectFixtureIsolation();assert.equal(isolation.isolated,true);assert.equal(isolation.contextsDistinct,true);
 assert.deepEqual(await gateway.inspectFixtureResources(),{targets:0,shards:0,contexts:0});
 console.log(JSON.stringify({passed:true,scenarios:results.length,results,storageIsolation:isolation}));
}catch(error){console.error(JSON.stringify({passed:false,completed:results,error:error.message,code:error.code}));process.exitCode=1}
finally{await gateway.closeSoopBrowserHost();await new Promise(r=>server.close(r))}
