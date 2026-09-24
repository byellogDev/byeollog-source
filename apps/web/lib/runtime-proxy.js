import {RUNTIME_HEADER,ensureFrontendRuntime} from './runtime-isolation.js';

const ENV_BY_RUNTIME={
  admin:['BYEOLLOG_ADMIN_RUNTIME_URL','BYEOLLOG_ADMIN_RUNTIME_TOKEN','BYEOLLOG_ADMIN_PROTECTION_BYPASS'],
  collector:['BYEOLLOG_COLLECTOR_RUNTIME_URL','BYEOLLOG_COLLECTOR_RUNTIME_TOKEN'],
  public:['BYEOLLOG_PUBLIC_RUNTIME_URL','BYEOLLOG_PUBLIC_RUNTIME_TOKEN']
};
const REQUEST_HEADERS=new Set([
  'authorization','content-type','cookie','origin','sec-fetch-site','user-agent',
  'x-forwarded-for','x-real-ip','x-byeollog-soop-sdk-secret',
  'x-byeollog-soop-gateway-secret','x-byeollog-soop-gateway-timestamp',
  'x-byeollog-soop-gateway-nonce','x-byeollog-soop-gateway-signature',
  'x-signature-ed25519','x-signature-timestamp','prefer'
]);
const RESPONSE_HEADERS=new Set([
  'cache-control','content-disposition','content-language','content-type','location',
  'retry-after','x-content-type-options','x-robots-tag'
]);
const MAX_BODY=12*1024*1024;
const MAX_RESPONSE=24*1024*1024;
const MINECRAFT_HEADERS=new Set(['x-byeollog-server-id','x-byeollog-request-id','x-byeollog-timestamp']);

function fixedOrigin(raw){
  let parsed;try{parsed=new URL(String(raw||''))}catch{return null}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash)return null;
  if(parsed.pathname!=='/'&&parsed.pathname!=='')return null;
  if(!/^[a-z0-9-]+\.vercel\.app$/i.test(parsed.hostname))return null;
  return parsed.origin;
}
function targetConfig(runtime,env){
  const names=ENV_BY_RUNTIME[runtime];if(!names)return null;
  const origin=fixedOrigin(env[names[0]]),token=String(env[names[1]]||'');
  const protectionBypass=String(env[names[2]]||'');
  if(!origin||!/^[a-f0-9]{64}$/i.test(token))return null;
  if(protectionBypass&&!/^[A-Za-z0-9_-]{32,128}$/.test(protectionBypass))return null;
  return {origin,token,protectionBypass};
}
function queryString(query={}){
  const result=new URLSearchParams();
  for(const [key,value] of Object.entries(query)){
    if(key.startsWith('__')||value===undefined||value===null)continue;
    for(const item of Array.isArray(value)?value:[value])result.append(key,String(item));
  }
  const text=result.toString();return text?`?${text}`:'';
}
function requestHeaders(req,token,protectionBypass='',endpoint=''){
  const headers=new Headers();
  for(const [name,value] of Object.entries(req.headers||{})){
    const lower=name.toLowerCase();if((!REQUEST_HEADERS.has(lower)&&!(endpoint==='/api/minecraft-server'&&MINECRAFT_HEADERS.has(lower)))||value===undefined)continue;
    headers.set(lower,Array.isArray(value)?value.join(', '):String(value));
  }
  headers.set(RUNTIME_HEADER,token);
  if(protectionBypass)headers.set('x-vercel-protection-bypass',protectionBypass);
  headers.set('x-forwarded-host','byeollog.com');
  headers.set('x-forwarded-proto','https');
  return headers;
}
async function streamBody(req,max=MAX_BODY){
  if(Buffer.isBuffer(req.body))return req.body;
  if(typeof req.body==='string')return Buffer.from(req.body);
  if(req.body!==undefined&&req.body!==null)return Buffer.from(JSON.stringify(req.body));
  if(typeof req.on!=='function')return null;
  return new Promise((resolve,reject)=>{
    let size=0,done=false;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>finish(Error('request body timeout')),5000);
    req.on('data',chunk=>{const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;if(size>max)finish(Object.assign(Error('request body too large'),{status:413}));else chunks.push(value)});
    req.on('end',()=>finish(null,Buffer.concat(chunks)));
    req.on('error',()=>finish(Error('request body unavailable')));
    req.on('aborted',()=>finish(Error('request body aborted')));
  });
}
function copyResponseHeaders(upstream,res){
  for(const [name,value] of upstream.headers){if(RESPONSE_HEADERS.has(name.toLowerCase()))res.setHeader(name,value)}
  const cookies=typeof upstream.headers.getSetCookie==='function'?upstream.headers.getSetCookie():[];
  if(cookies.length)res.setHeader('Set-Cookie',cookies);
  res.setHeader('Cache-Control',upstream.headers.get('cache-control')||'no-store, private');
  res.setHeader('X-Vercel-Enable-Rewrite-Caching','0');
}

export function createRuntimeProxyHandler({runtime,endpoint,chooseRuntime,rawBody=false,env=process.env,fetcher=fetch}={}){
  if(!/^\/api\/[a-z0-9-]+$/i.test(endpoint||''))throw new TypeError('fixed API endpoint is required');
  return async function proxyHandler(req,res){
    const problems=ensureFrontendRuntime(env);
    if(problems.length){console.error('[runtime-proxy] frontend isolation failed',{problems});return res.status(503).json({message:'Service temporarily unavailable'})}
    const selected=chooseRuntime?chooseRuntime(req):runtime,config=targetConfig(selected,env);
    if(!config)return res.status(503).json({message:'Service temporarily unavailable'});
    const method=String(req.method||'GET').toUpperCase();
    if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))return res.status(405).json({message:'Method not allowed'});
    let body=null;
    if(!['GET','HEAD'].includes(method)){
      try{body=await streamBody(req,rawBody?65536:MAX_BODY)}catch(error){return res.status(error?.status||400).json({message:error?.status===413?'Payload too large':'Invalid body'})}
      if(body&&body.length>(rawBody?65536:MAX_BODY))return res.status(413).json({message:'Payload too large'});
    }
    const url=config.origin+endpoint+queryString(req.query);
    let upstream;
    try{
      upstream=await fetcher(url,{method,headers:requestHeaders(req,config.token,config.protectionBypass,endpoint),body:body?.length?body:undefined,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(rawBody?12000:65000)});
    }catch(error){console.error('[runtime-proxy] upstream unavailable',{runtime:selected,type:error?.name||'Error'});return res.status(503).json({message:'Service temporarily unavailable'})}
    copyResponseHeaders(upstream,res);
    const length=Number(upstream.headers.get('content-length')||0);
    if(length>MAX_RESPONSE)return res.status(502).json({message:'Invalid upstream response'});
    const data=Buffer.from(await upstream.arrayBuffer());
    if(data.length>MAX_RESPONSE)return res.status(502).json({message:'Invalid upstream response'});
    return res.status(upstream.status).send(data);
  };
}
