import {createClient} from '@supabase/supabase-js';
let cached=null,inFlight=null;
export function backupWorkerConfiguration(env=process.env){
 const url=String(env.SUPABASE_URL||'').replace(/\/+$/,'');
 const apikey=String(env.SUPABASE_ANON_KEY||''),email=String(env.BYEOLLOG_BACKUP_ACCOUNT_EMAIL||''),password=String(env.BYEOLLOG_BACKUP_ACCOUNT_PASSWORD||'');
 if(env.BYEOLLOG_RUNTIME!=='backup'||!url.startsWith('https://')||!email||password.length<32)throw Error('Backup worker configuration unavailable');
 if(env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY||env.SESSION_SECRET||env.SOOP_CLIENT_SECRET||env.SOOP_TOKEN_ENCRYPTION_KEY)throw Error('Privileged credentials are not allowed in the backup worker');
 let role='';try{role=JSON.parse(Buffer.from(apikey.split('.')[1]||'','base64url').toString()).role}catch{}
 if(!apikey.startsWith('sb_publishable_')&&role!=='anon')throw Error('Backup worker requires an anonymous API key');
 return {url,apikey,email,password};
}
async function token(config){
 const signature=JSON.stringify(config);
 if(cached?.configuration===signature&&cached.expiresAt>Date.now()+300000)return cached.token;
 if(inFlight?.configuration===signature)return inFlight.promise;
 const promise=(async()=>{
  const response=await fetch(config.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:config.apikey,'content-type':'application/json'},body:JSON.stringify({email:config.email,password:config.password}),signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(!response.ok)throw Error('Backup worker authentication failed');
  const session=await response.json();
  if(typeof session.access_token!=='string'||!Number.isFinite(session.expires_in)||session.expires_in<600)throw Error('Backup worker session unavailable');
  cached={configuration:signature,token:session.access_token,expiresAt:Date.now()+session.expires_in*1000};
  return cached.token;
 })();
 inFlight={configuration:signature,promise};try{return await promise}finally{if(inFlight?.promise===promise)inFlight=null}
}
export async function backupWorkerClient(signal){
 const config=backupWorkerConfiguration(),accessToken=await token(config);
 return createClient(config.url,config.apikey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{headers:{Authorization:'Bearer '+accessToken},fetch:(input,init={})=>fetch(input,{...init,signal:signal?(init.signal?AbortSignal.any([signal,init.signal]):signal):init.signal})}});
}
const OPERATIONS=Object.freeze({'rpc/byeollog_export_backup_v10':'export','rpc/begin_workspace_backup_v1':'begin','rpc/release_workspace_backup_lease_v1':'release','rpc/byeollog_backup_retention_inventory_v1':'inventory'});
export async function backupWorkerRest(table,path='',options={}){
 if(!Object.hasOwn(OPERATIONS,table)||path||(options.method||'GET').toUpperCase()!=='POST')throw Error('Operation is outside backup worker permissions');
 const client=await backupWorkerClient(options.signal);
 const {data,error}=await client.rpc('byeollog_backup_worker_v1',{p_operation:OPERATIONS[table],p_args:options.body||{}});
 if(error){const failure=new Error('Backup database operation failed');failure.code=/^[A-Za-z0-9_-]{1,32}$/.test(error.code||'')?error.code:'backup_failed';throw failure}
 return data;
}
