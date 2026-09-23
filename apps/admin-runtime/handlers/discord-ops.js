import {waitUntil} from '@vercel/functions';
import {discordSignatureValid,validateOpsInteraction,formatOpsStatus,createOpsLimiter,ephemeral} from '../lib/discord-ops.js';
export const config={api:{bodyParser:false}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Each instance shares a short cache and coalesces simultaneous reads.
export function createDiscordOpsHandler({env=process.env,fetcher=fetch,defer=waitUntil,now=Date.now,sleep=pause,log=console.error}={}){
 const limit=createOpsLimiter();let cached=null,pending=null;
 async function snapshot(){
  if(cached&&now()-cached.at<15000)return cached.data;
  if(pending)return pending;
  pending=(async()=>{
   const url=(env.SUPABASE_URL||'').replace(/\/+$/,''),key=env.SUPABASE_SECRET_KEY,role=env.SUPABASE_SERVICE_ROLE_KEY;
   if(!url||!key||!role)throw Error('configuration');
   const r=await fetcher(url+'/rest/v1/rpc/byeollog_ops_read_snapshot_v1',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+role,'Content-Type':'application/json'},body:'{}',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(2500)});
   if(!r.ok)throw Error('snapshot unavailable');
   const text=await r.text();if(text.length>32768)throw Error('snapshot too large');
   const data=JSON.parse(text);cached={at:now(),data};return data;
  })();
  try{return await pending}finally{pending=null}
 }
 async function finish(data){
  let message;
  try{message=formatOpsStatus(data.data.name,await snapshot(),{now:now()})}
  catch{message=formatOpsStatus(data.data.name,null,{failed:true})}
  // Fixed host/application and validated token; never execute a caller-supplied URL.
  const url='https://discord.com/api/v10/webhooks/'+env.DISCORD_OPS_APPLICATION_ID+'/'+data.token+'/messages/@original';
  let status=0;
  for(let attempt=0;attempt<2;attempt++){
   let retry=250;
   try{
    const r=await fetcher(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(4000)});
    if(r.ok)return;
    status=r.status;
    if(status===429){const seconds=Number(r.headers.get('Retry-After'));if(!Number.isFinite(seconds)||seconds>1||seconds<0)break;retry=Math.max(250,seconds*1000)}
    else if(status<500)break;
   }catch{status=0}
   if(attempt===0)await sleep(retry);
  }
  log('discord_ops_response_failed',{status});
 }
 return async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const applicationId=env.DISCORD_OPS_APPLICATION_ID,publicKey=env.DISCORD_OPS_PUBLIC_KEY;
  if(!/^[0-9]{17,20}$/.test(applicationId||'')||!/^[a-f0-9]{64}$/i.test(publicKey||''))return res.status(503).json({message:'Command service not configured'});
  if(Number(req.headers['content-length']||0)>65536)return res.status(413).json({message:'Payload too large'});
  let raw;try{raw=await rawBody(req)}catch{return res.status(400).json({message:'Invalid body'})}
  if(raw.length>65536)return res.status(413).json({message:'Payload too large'});
  if(!discordSignatureValid({publicKey,signature:req.headers['x-signature-ed25519'],timestamp:req.headers['x-signature-timestamp'],raw,now:now()}))return res.status(401).json({message:'Invalid request signature'});
  let data;try{data=JSON.parse(raw.toString('utf8'))}catch{return res.status(400).json({message:'Invalid JSON'})}
  const denial=validateOpsInteraction(data,applicationId);
  if(denial)return res.status(200).json({type:4,data:ephemeral(denial)});
  if(data.type===1)return res.status(200).json({type:1});
  if(!limit(data.member.user.id,data.id,now()))return res.status(200).json({type:4,data:ephemeral('잠시 후 다시 조회해주세요. 명령은 5초 간격으로 사용할 수 있습니다.')});
  res.status(200).json({type:5,data:{flags:64}});
  defer(finish(data));
 };
}
async function rawBody(req){
 // Vercel's Node helper installs a lazy JSON getter on req.body and restores
 // raw bytes through data/end listeners. Do not access that getter or reserialize
 // JSON: both would break Discord's signature over the exact original bytes.
 if(typeof req.on==='function')return new Promise((resolve,reject)=>{
  let size=0,settled=false;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
  const timer=setTimeout(()=>finish(Error('body timeout')),2000);
  req.on('data',chunk=>{if(settled)return;const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>65536)finish(Error('too large'));else chunks.push(b)});
  req.on('end',()=>finish(null,Buffer.concat(chunks)));
  req.on('error',()=>finish(Error('body unavailable')));
  req.on('aborted',()=>finish(Error('body aborted')));
 });
 if(Buffer.isBuffer(req.body))return req.body;
 if(typeof req.body==='string')return Buffer.from(req.body);
 if(req.body!==undefined&&req.body!==null)throw Error('unverifiable body');
 throw Error('raw body unavailable');
}
export default createDiscordOpsHandler();
