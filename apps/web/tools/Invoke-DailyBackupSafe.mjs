// One-shot operational probe. Vercel injects production env variables directly
// into this process; this script never writes or prints the credential.
const secret=process.env.CRON_SECRET||'';
if(secret.length<16)throw new Error('CRON_SECRET is unavailable or too short.');

const endpoint=new URL('/api/backups?cron=daily','https://byeollog.com');
if(endpoint.origin!=='https://byeollog.com')throw new Error('Unexpected backup endpoint.');
const started=Date.now();
const response=await fetch(endpoint,{
  method:'GET',
  headers:{Authorization:`Bearer ${secret}`,'User-Agent':'byeollog-backup-verification/1.0'},
  redirect:'error',
  signal:AbortSignal.timeout(20*60*1000)
});
let body=null;
try{body=await response.json();}catch{}
if(!response.ok || body?.ok!==true){
  throw new Error(`Daily backup verification failed (${response.status}).`);
}
const items=Array.isArray(body.items)?body.items:[];
if(!Number.isSafeInteger(body.created) || !Number.isSafeInteger(body.failed)
  || body.failed!==0 || items.length!==body.created){
  throw new Error('Daily backup result shape is invalid.');
}
const compressedBytes=items.reduce((sum,item)=>sum+(Number.isSafeInteger(item?.compressed_bytes)?item.compressed_bytes:0),0);
console.log(JSON.stringify({
  ok:true,
  status:response.status,
  created:body.created,
  failed:body.failed,
  compressedBytes,
  durationMs:Date.now()-started
}));
