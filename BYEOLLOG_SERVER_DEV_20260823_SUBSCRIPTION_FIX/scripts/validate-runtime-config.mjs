const REQUIRED_PROJECT_REF='offslvwaugvjotkywlus';
const REQUIRED_PROJECT_URL=`https://${REQUIRED_PROJECT_REF}.supabase.co`;
const REQUIRED_AUTOMATION_MODE='offsl-vnext-g3a-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errors=[];
const value=name=>String(process.env[name]||'').trim();
const requireValue=(name,minLength=1)=>{
  const current=value(name);
  if(current.length<minLength)errors.push(`${name}: missing or too short`);
  return current;
};

const supabaseUrl=requireValue('SUPABASE_URL');
if(supabaseUrl!==REQUIRED_PROJECT_URL)errors.push('SUPABASE_URL: unexpected production project');
requireValue('SUPABASE_ANON_KEY',24);
requireValue('SUPABASE_SECRET_KEY',24);
requireValue('SUPABASE_SERVICE_ROLE_KEY',24);
requireValue('SESSION_SECRET',32);
requireValue('COLLECTOR_TOKEN',24);
requireValue('CRON_SECRET',24);

const workspaceId=requireValue('BYEOLLOG_LEGACY_WORKSPACE_ID');
if(workspaceId&&!UUID.test(workspaceId))errors.push('BYEOLLOG_LEGACY_WORKSPACE_ID: invalid UUID');
if(value('BYEOLLOG_AUTOMATION_PROJECT_URL')!==REQUIRED_PROJECT_URL){
  errors.push('BYEOLLOG_AUTOMATION_PROJECT_URL: unexpected project');
}
if(value('BYEOLLOG_AUTOMATION_PROJECT_REF')!==REQUIRED_PROJECT_REF){
  errors.push('BYEOLLOG_AUTOMATION_PROJECT_REF: unexpected project ref');
}
if(value('BYEOLLOG_AUTOMATION_SESSION_MODE')!==REQUIRED_AUTOMATION_MODE){
  errors.push('BYEOLLOG_AUTOMATION_SESSION_MODE: automation release gate is not enabled');
}

const adminEmails=requireValue('PLATFORM_ADMIN_EMAILS')
  .split(',').map(item=>item.trim()).filter(Boolean);
if(adminEmails.length===0||adminEmails.some(item=>!EMAIL.test(item))){
  errors.push('PLATFORM_ADMIN_EMAILS: expected a comma-separated email allowlist');
}

const resetUrl=value('PASSWORD_RESET_REDIRECT_URL');
if(resetUrl){
  try{
    const parsed=new URL(resetUrl);
    if(parsed.protocol!=='https:'||parsed.origin!=='https://byeollog.com'||parsed.pathname!=='/reset-password'
      ||parsed.username||parsed.password||parsed.search||parsed.hash){
      errors.push('PASSWORD_RESET_REDIRECT_URL: expected https://byeollog.com/reset-password');
    }
  }catch{
    errors.push('PASSWORD_RESET_REDIRECT_URL: invalid URL');
  }
}

const maintenance=value('BYEOLLOG_MAINTENANCE_MODE');
if(maintenance&&maintenance!=='write-blocked-v1'){
  errors.push('BYEOLLOG_MAINTENANCE_MODE: unknown mode');
}

const soopOauthEnabled=value('SOOP_OAUTH_ENABLED');
if(soopOauthEnabled&&soopOauthEnabled!=='true'&&soopOauthEnabled!=='false'){
  errors.push('SOOP_OAUTH_ENABLED: expected true or false');
}
if(soopOauthEnabled==='true'){
  requireValue('SOOP_CLIENT_ID',16);
  requireValue('SOOP_CLIENT_SECRET',24);
  const soopRedirect=value('SOOP_REDIRECT_URI')||'https://byeollog.com/api/auth/soop/callback';
  if(soopRedirect!=='https://byeollog.com/api/auth/soop/callback'){
    errors.push('SOOP_REDIRECT_URI: must match the registered production callback');
  }
  const encryptionKey=requireValue('SOOP_TOKEN_ENCRYPTION_KEY',43);
  let decodedKeyLength=0;
  if(/^[0-9a-f]{64}$/i.test(encryptionKey))decodedKeyLength=32;
  else{try{decodedKeyLength=Buffer.from(encryptionKey,'base64url').length}catch{decodedKeyLength=0}}
  if(decodedKeyLength!==32)errors.push('SOOP_TOKEN_ENCRYPTION_KEY: expected exactly 32 encoded bytes');
}

if(value('SOOP_CHAT_SDK_ENABLED')==='true'&&soopOauthEnabled!=='true'){
  errors.push('SOOP_CHAT_SDK_ENABLED: requires SOOP_OAUTH_ENABLED=true');
}

if(errors.length){
  console.error(`Runtime configuration invalid (${errors.length}):`);
  for(const error of errors)console.error(`- ${error}`);
  process.exitCode=1;
}else{
  console.log('Runtime configuration is valid. Secret values were not printed.');
}
