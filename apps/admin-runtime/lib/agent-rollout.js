import {readFile} from 'node:fs/promises';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION=/^\d{1,4}\.\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const DEVICE_STATES=new Set(['online','idle','offline','never_reported','revoked']);
const EXECUTION_STATES=new Set(['queued','running','retry_scheduled','succeeded','failed']);
const COLLECTION_STATES=new Set(['collecting','idle','recovering','error','stalled','unknown','not_configured']);
const GATEWAY_STATES=new Set(['idle','connecting','waiting_for_live','connected','retry_wait','reauthorization_required','stopped']);
const stableCatalogPath=new URL('../agent-updates/stable/win-x64.json',import.meta.url);

function text(value,max=160){return String(value??'').trim().slice(0,max)}
function integer(value,min=0,max=1_000_000){
  const number=Number(value);
  return Number.isInteger(number)&&number>=min&&number<=max?number:0;
}
function instant(value){
  if(value===null||value===undefined||value==='')return null;
  const parsed=new Date(String(value));
  return Number.isFinite(parsed.getTime())?parsed.toISOString():null;
}
function uuid(value){const normalized=text(value,64);return UUID.test(normalized)?normalized:null}
function executionStatus(value){const normalized=text(value,40);return EXECUTION_STATES.has(normalized)?normalized:'unknown'}
function collectionState(value){const normalized=text(value,40);return COLLECTION_STATES.has(normalized)?normalized:'unknown'}
function stringList(value,max=32){
  return Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'&&/^[a-z][a-z0-9_.-]{0,119}$/.test(item)))].slice(0,max):[];
}
function sanitizeCollectionHealth(raw){
  const source=raw&&typeof raw==='object'?raw:{};
  const devices=(Array.isArray(source.devices)?source.devices:[]).map(row=>{
    if(!row||typeof row!=='object')return null;
    const workspaceId=uuid(row.workspaceId),deviceId=uuid(row.deviceId);
    if(!workspaceId||!deviceId)return null;
    return {
      workspaceId,deviceId,displayName:text(row.displayName,120)||'등록 PC',
      state:collectionState(row.state),reportedState:collectionState(row.reportedState),
      sessionStartedAt:instant(row.sessionStartedAt),lastObservedAt:instant(row.lastObservedAt),
      lastUploadAt:instant(row.lastUploadAt),reportedAt:instant(row.reportedAt)
    };
  }).filter(Boolean);
  return {
    status:collectionState(source.status),
    activeDeviceCount:integer(source.activeDeviceCount),
    collectingDeviceCount:integer(source.collectingDeviceCount),
    lastObservedAt:instant(source.lastObservedAt),lastUploadAt:instant(source.lastUploadAt),
    lastCollectionReportAt:instant(source.lastCollectionReportAt),devices
  };
}
function sanitizeSafetyDecision(row){
  if(!row||typeof row!=='object')return null;
  const id=uuid(row.id),workspaceId=uuid(row.workspaceId);
  if(!id||!workspaceId||text(row.decisionType,64)!=='late_event_suppressed')return null;
  return {id,workspaceId,workspaceName:text(row.workspaceName,120)||'워크스페이스',
    decisionType:'late_event_suppressed',decisionReason:text(row.decisionReason,100),
    occurredAt:instant(row.occurredAt),receivedAt:instant(row.receivedAt),recordedAt:instant(row.recordedAt),
    suppressedActionTypes:stringList(row.suppressedActionTypes),
    suppressedActionCount:integer(row.suppressedActionCount,0,32)};
}

export async function loadStableAgentRelease(){
  const envelope=JSON.parse(await readFile(stableCatalogPath,'utf8'));
  if(envelope?.schemaVersion!==1||typeof envelope?.payload!=='string')throw new Error('stable agent catalog is invalid');
  const payload=JSON.parse(Buffer.from(envelope.payload,'base64').toString('utf8'));
  if(payload?.schemaVersion!==1||payload?.channel!=='stable'||payload?.platform!=='win-x64'||!VERSION.test(String(payload?.version||''))){
    throw new Error('stable agent catalog payload is invalid');
  }
  return Object.freeze({
    version:String(payload.version),
    displayVersion:text(payload.displayVersion||payload.version,40),
    releaseSequence:integer(payload.releaseSequence,1,9_999_999_999),
    publishedAt:instant(payload.publishedAtUtc)
  });
}

function sanitizeExecution(row){
  if(!row||typeof row!=='object')return null;
  const id=uuid(row.id),deviceId=uuid(row.deviceId);
  if(!id||!deviceId)return null;
  return {
    id,
    workspaceId:uuid(row.workspaceId),
    workspaceName:text(row.workspaceName,120)||'워크스페이스',
    deviceId,
    deviceName:text(row.deviceName,120)||'등록 PC',
    status:executionStatus(row.status),
    actionType:text(row.actionType,120)||'unknown',
    attemptNo:integer(row.attemptNo,0,100),
    createdAt:instant(row.createdAt),
    startedAt:instant(row.startedAt),
    finishedAt:instant(row.finishedAt)
  };
}

export function sanitizeAgentRolloutSnapshot(raw,release,operations={}){
  const latestVersion=VERSION.test(String(release?.version||''))?String(release.version):null;
  if(!raw||typeof raw!=='object'||!latestVersion)throw new Error('agent rollout snapshot is invalid');
  const devices=(Array.isArray(raw.devices)?raw.devices:[]).map(row=>{
    if(!row||typeof row!=='object')return null;
    const deviceId=uuid(row.deviceId),workspaceId=uuid(row.workspaceId);
    if(!deviceId||!workspaceId)return null;
    const connectionState=DEVICE_STATES.has(String(row.connectionState))?String(row.connectionState):'offline';
    const latestExecution=sanitizeExecution(row.latestExecution);
    return {
      workspaceId,
      workspaceName:text(row.workspaceName,120)||'워크스페이스',
      workspaceSlug:text(row.workspaceSlug,64)||null,
      deviceId,
      displayName:text(row.displayName,120)||'등록 PC',
      registeredAt:instant(row.registeredAt),
      lastSeenAt:instant(row.lastSeenAt),
      lastReportedAt:instant(row.lastReportedAt),
      revokedAt:instant(row.revokedAt),
      agentVersion:VERSION.test(String(row.agentVersion||''))?String(row.agentVersion):null,
      platform:text(row.platform,80)||null,
      connectionState,
      recentExecutionCount:integer(row.recentExecutionCount),
      succeededCount:integer(row.succeededCount),
      failedCount:integer(row.failedCount),
      pendingCount:integer(row.pendingCount),
      consecutiveFailureCount:integer(row.consecutiveFailureCount,0,10_000),
      latestExecution
    };
  }).filter(Boolean);
  const recentExecutions=(Array.isArray(raw.recentExecutions)?raw.recentExecutions:[])
    .map(sanitizeExecution).filter(Boolean).slice(0,100);
  operations=operations&&typeof operations==='object'?operations:{};
  const workspaceNames=new Map(devices.map(device=>[device.workspaceId,device.workspaceName]));
  const sessions=new Map((Array.isArray(operations.sessions)?operations.sessions:[]).map(row=>[uuid(row?.workspace_id),row]));
  const gateways=(Array.isArray(operations.controls)?operations.controls:[]).map(row=>{
    const workspaceId=uuid(row?.workspace_id);if(!workspaceId)return null;
    const session=sessions.get(workspaceId)||{};
    const state=GATEWAY_STATES.has(String(session.state))?String(session.state):'stopped';
    const heartbeatAt=instant(session.heartbeat_at),heartbeatAge=heartbeatAt?Date.now()-new Date(heartbeatAt).getTime():Infinity;
    const enabled=row.gateway_enabled===true&&row.core_collection_enabled===true;
    // Offline channels intentionally report every five minutes. Allow one
    // report interval and scheduling grace; keep live-channel detection fast.
    const staleAfterMs=state==='waiting_for_live'?360000:120000;
    const health=!enabled?'disabled':heartbeatAge>staleAfterMs?'stale':state==='connected'?'connected':state==='waiting_for_live'?'waiting_for_live':state;
    return {workspaceId,workspaceName:workspaceNames.get(workspaceId)||'워크스페이스',enabled,state,health,
      heartbeatAt,lastEventAt:instant(session.last_event_at),connectedAt:instant(session.connected_at),
      lastErrorCode:text(session.last_error_code,120)||null};
  }).filter(Boolean);
  return {
    ok:true,
    generatedAt:instant(raw.generatedAt)||new Date().toISOString(),
    scope:raw.scope==='platform'?'platform':'workspace',
    release:{...release,version:latestVersion},
    devices,
    recentExecutions,
    coreCollection:{gateways,enabledCount:gateways.filter(item=>item.enabled).length,
      healthyCount:gateways.filter(item=>['connected','waiting_for_live'].includes(item.health)).length},
    collectionHealth:sanitizeCollectionHealth(raw.collectionHealth),
    recentSafetyDecisions:(Array.isArray(raw.recentSafetyDecisions)?raw.recentSafetyDecisions:[])
      .map(sanitizeSafetyDecision).filter(Boolean).slice(0,100)
  };
}
