export const AUTOMATION_SESSION_CAPABILITY='offsl-session-v1';
export const AUTOMATION_SESSION_MODE='offsl-vnext-g3a-v1';
export const MIN_AUTOMATION_SESSION_COLLECTOR_VERSION='0.6.3.3';
export const REQUIRED_AUTOMATION_SCHEMA_REVISION='offsl-vnext-g3a-v1';
export const OFFSL_AUTOMATION_PROJECT_URL='https://offslvwaugvjotkywlus.supabase.co';
export const OFFSL_AUTOMATION_PROJECT_REF='offslvwaugvjotkywlus';
// SHA-256 of the explicit 2026-08-20 public-release risk acceptance phrase.
// This value is release evidence, not a credential.
export const PUBLIC_AUTOMATION_RELEASE_EVIDENCE='472aeddc19d84a1b236e4edc3dcaf6922563ec70de2081f509264ff5656ab273';

function versionTuple(value){
  const match=/^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(value||'').trim());
  if(!match)return null;
  return [Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4]||0)];
}

export function isCollectorVersionAtLeast(value,minimum=MIN_AUTOMATION_SESSION_COLLECTOR_VERSION){
  const current=versionTuple(value),required=versionTuple(minimum);
  if(!current||!required)return false;
  for(let i=0;i<4;i++){
    if(current[i]>required[i])return true;
    if(current[i]<required[i])return false;
  }
  return true;
}

export function normalizeSupabaseProject(value){
  try{
    const url=new URL(String(value||''));
    if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
    if(url.pathname!=='/'||url.search||url.hash)return null;
    const match=/^([a-z0-9]{20})\.supabase\.co$/i.exec(url.hostname);
    if(!match)return null;
    return {origin:url.origin.toLowerCase(),projectRef:match[1].toLowerCase()};
  }catch{return null}
}

export function requestsAutomationSession(requestBody){
  return requestBody?.automation_capability===AUTOMATION_SESSION_CAPABILITY;
}

function isUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));
}

/**
 * Cheap request/configuration gate. It is intentionally separate from the
 * service-derived database gates so legacy requests never trigger automation
 * reads and request fields can never assert server readiness.
 */
export function evaluateAutomationSessionRequest({
  requestBody,
  supabaseUrl,
  configuredProjectUrl,
  configuredProjectRef,
  automationSessionMode
}={}){
  if(!requestsAutomationSession(requestBody))return {eligible:false,reason:'capability_not_requested'};
  if(!isCollectorVersionAtLeast(requestBody?.collector_version))return {eligible:false,reason:'collector_version_unsupported'};
  if(automationSessionMode!==AUTOMATION_SESSION_MODE)return {eligible:false,reason:'feature_disabled'};

  const serverProject=normalizeSupabaseProject(supabaseUrl);
  if(!serverProject
    || serverProject.origin!==OFFSL_AUTOMATION_PROJECT_URL
    || serverProject.projectRef!==OFFSL_AUTOMATION_PROJECT_REF){
    return {eligible:false,reason:'server_project_invalid'};
  }
  if(configuredProjectUrl!==OFFSL_AUTOMATION_PROJECT_URL){
    return {eligible:false,reason:'configured_project_url_mismatch'};
  }
  if(configuredProjectRef!==OFFSL_AUTOMATION_PROJECT_REF){
    return {eligible:false,reason:'configured_project_ref_mismatch'};
  }

  return {
    eligible:true,
    reason:'request_eligible',
    projectUrl:OFFSL_AUTOMATION_PROJECT_URL,
    projectRef:OFFSL_AUTOMATION_PROJECT_REF
  };
}

/**
 * Final pure policy. `readiness` must be the single row returned by the
 * service-only workspace-scoped readiness RPC, never a value copied from the
 * Collector request.
 */
export function evaluateAutomationSessionEligibility({
  requestBody,
  supabaseUrl,
  configuredProjectUrl,
  configuredProjectRef,
  automationSessionMode,
  readiness=null,
  authorizedWorkspaceId='',
  authorizedUserId=''
}={}){
  const requestDecision=evaluateAutomationSessionRequest({
    requestBody,
    supabaseUrl,
    configuredProjectUrl,
    configuredProjectRef,
    automationSessionMode
  });
  if(!requestDecision.eligible)return requestDecision;

  if(readiness?.ready!==true
    || readiness?.revision!==REQUIRED_AUTOMATION_SCHEMA_REVISION
    || readiness?.project_ref!==OFFSL_AUTOMATION_PROJECT_REF
    || readiness?.workspace_id!==authorizedWorkspaceId
    || readiness?.authorized_user_id!==authorizedUserId){
    return {eligible:false,reason:'schema_not_ready'};
  }
  if(!isUuid(authorizedWorkspaceId)||!isUuid(authorizedUserId)){
    return {eligible:false,reason:'identity_not_authorized'};
  }

  return {
    eligible:true,
    reason:'eligible',
    projectUrl:requestDecision.projectUrl,
    projectRef:requestDecision.projectRef,
    workspaceId:authorizedWorkspaceId
  };
}

export function buildAutomationSessionResponseFields(decision,authSession){
  if(decision?.eligible!==true)return {};
  const accessToken=String(authSession?.access_token||'');
  const refreshToken=String(authSession?.refresh_token||'');
  const expiresIn=authSession?.expires_in;
  if(!accessToken||!refreshToken)return {};
  if(authSession?.token_type!=='bearer')return {};
  if(!Number.isInteger(expiresIn)||expiresIn<60||expiresIn>86400)return {};

  return {
    automation_ready:true,
    automation_capability:AUTOMATION_SESSION_CAPABILITY,
    automation_project_ref:decision.projectRef,
    automation_project_url:decision.projectUrl,
    automation_workspace_id:decision.workspaceId,
    automation_session:{
      access_token:accessToken,
      refresh_token:refreshToken,
      expires_in:expiresIn,
      token_type:'bearer'
    }
  };
}
