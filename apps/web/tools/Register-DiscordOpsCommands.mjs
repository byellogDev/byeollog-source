import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {OPS_GUILD,OPS_CHANNEL,OPS_COMMANDS} from '../lib/discord-ops.js';

// Run locally once. Only the public Application ID/Public Key belong on Vercel.
export async function registerOpsCommands({applicationId,clientSecret,fetcher=fetch}){
 if(!/^[0-9]{17,20}$/.test(applicationId||'')||typeof clientSecret!=='string'||clientSecret.length<16||clientSecret.length>256)throw Error('Invalid local application credentials');
 const root='https://discord.com/api/v10';
 const auth='Basic '+Buffer.from(applicationId+':'+clientSecret).toString('base64');
 const request=async(path,options={})=>{
  const r=await fetcher(root+path,{...options,redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('Discord registration request failed (HTTP '+r.status+')');
  const text=await r.text();if(text.length>262144)throw Error('Discord registration response too large');
  return text?JSON.parse(text):{};
 };
 const token=await request('/oauth2/token',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'applications.commands.update'}).toString()});
 if(typeof token.access_token!=='string'||token.token_type?.toLowerCase()!=='bearer')throw Error('Command registration authentication failed');
 try{
  const path=`/applications/${applicationId}/guilds/${OPS_GUILD}/commands`,headers={Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'};
  const before=await request(path,{headers});if(!Array.isArray(before))throw Error('Invalid command list');
  // Per-name upsert preserves unrelated commands; never bulk replace the list.
  for(const command of OPS_COMMANDS)await request(path,{method:'POST',headers,body:JSON.stringify({...command,options:[]})});
  const after=await request(path,{headers});
  const correct=OPS_COMMANDS.every(c=>after.some(a=>a.name===c.name&&a.type===1&&a.application_id===applicationId&&a.guild_id===OPS_GUILD&&a.default_member_permissions==='8'&&a.description===c.description&&!a.options?.length));
  const unrelated=before.filter(c=>!OPS_COMMANDS.some(o=>o.name===c.name&&c.type===1));
  if(!correct||unrelated.some(c=>!after.some(a=>a.id===c.id)))throw Error('Command registration verification failed');
  return {registered:true,applicationId,guildId:OPS_GUILD,channelId:OPS_CHANNEL,commands:OPS_COMMANDS.map(c=>c.name),unrelatedCommandsPreserved:unrelated.length};
 }finally{
  // The short-lived registration credential is not retained in files or logs.
  try{await request('/oauth2/token/revoke',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:token.access_token,token_type_hint:'access_token'}).toString()})}catch{/* Expiry still applies if revocation is unavailable. */}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [applicationId,file,...extra]=process.argv.slice(2);
  if(!file||extra.length)throw Error('Usage: node tools/Register-DiscordOpsCommands.mjs APPLICATION_ID LOCAL_CLIENT_SECRET_FILE');
  const input=await readFile(file);if(input.length>1024)throw Error('Credential file too large');
  const clientSecret=input.toString('utf8').replace(/^\uFEFF/,'').trim();
  console.log(JSON.stringify(await registerOpsCommands({applicationId,clientSecret})));
 }catch{console.error('Discord command registration failed. Check the app ID, local client secret, app installation and Discord API status. No credential was logged.');process.exitCode=1}
}
