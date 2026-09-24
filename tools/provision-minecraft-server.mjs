import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {normalizeMinecraftUuid,sha256} from '../apps/admin-runtime/lib/game-link-security.mjs';

// Persist the same identity before the RPC. Ambiguous failures never destroy
// the only copy of the credential, and resume never silently rotates a key.
export async function provision({serverKey,displayName,minecraftUuid,directory='.local/minecraft-server-credentials',resume=false,env=process.env,fetchImpl=fetch}) {
  if(!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(serverKey)||!displayName?.trim()||displayName.trim().length>80)throw Error('invalid_server_details');
  minecraftUuid=normalizeMinecraftUuid(minecraftUuid);
  const origin=new URL(env.SUPABASE_URL);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('invalid_database_origin');
  if(!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('missing_database_credential');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.resolve(directory,serverKey+'.json');
  let saved;
  if(resume){
    saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.serverKey!==serverKey||saved.minecraftUuid!==minecraftUuid||saved.displayName!==displayName.trim()||!/^bms_[A-Za-z0-9_-]{43}$/.test(saved.apiKey)||!/^[a-f0-9-]{36}$/.test(saved.serverId))throw Error('resume_identity_mismatch');
  }else{
    saved={serverKey,displayName:displayName.trim(),minecraftUuid,serverId:crypto.randomUUID(),apiKey:'bms_'+crypto.randomBytes(32).toString('base64url'),createdAt:new Date().toISOString()};
    await fs.writeFile(file,JSON.stringify(saved,null,2),{flag:'wx',mode:0o600});
  }
  const hash=sha256(saved.apiKey);
  async function call(route,body){
    const response=await fetchImpl(origin.origin+'/rest/v1/'+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok)throw Error('database_request_failed');
    return response.json();
  }
  async function verified(){
    const rows=await call('byeollog_minecraft_servers?select=id,status,api_key_hash&id=eq.'+saved.serverId);
    if(!rows.length)return false;
    if(rows[0].status!=='active'||rows[0].api_key_hash!==hash)throw Error('credential_conflict');
    const grants=await call('byeollog_minecraft_server_player_grants?select=binding_id,byeollog_game_identity_bindings!inner(minecraft_uuid,status)&server_id=eq.'+saved.serverId+'&status=eq.active&byeollog_game_identity_bindings.minecraft_uuid=eq.'+minecraftUuid+'&byeollog_game_identity_bindings.status=eq.active');
    if(!grants.length)throw Error('grant_not_active');
    return true;
  }
  try{
    if(resume&&await verified())return {file,recovered:true};
    await call('rpc/byeollog_provision_minecraft_server',{p_server_id:saved.serverId,p_server_key:serverKey,p_display_name:saved.displayName,p_api_key_hash:hash,p_minecraft_uuid:minecraftUuid});
    if(!await verified())throw Error('not_verified');
    return {file,recovered:false};
  }catch{
    // Even an HTTP failure can follow a commit. Retain the private file and
    // check the database rather than issue a different credential.
    try{if(await verified())return {file,recovered:true};}catch{}
    throw Error('provision_unconfirmed_credentials_retained_use_resume');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?'':process.argv[i+1]||'';};
  try{const result=await provision({serverKey:arg('server-key'),displayName:arg('display-name'),minecraftUuid:arg('minecraft-uuid'),resume:process.argv.includes('--resume')});console.log(JSON.stringify(result));}
  catch(error){console.error(error.code==='EEXIST'?'credential_file_exists_use_resume':error.message);process.exitCode=1;}
}
