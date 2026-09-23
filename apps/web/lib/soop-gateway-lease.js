import crypto from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_VERSION=1;

function clean(value,max){
  const result=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return result&&result.length<=max?result:'';
}

export function normalizeSoopBroadcasterId(value){
  const result=clean(value,180).toLowerCase();
  return /^[a-z0-9_.-]+$/.test(result)?result:'';
}

function secretFor(environment={}){
  const value=String(environment.SOOP_GATEWAY_LEASE_SECRET||environment.SOOP_GATEWAY_INGRESS_SECRET||'').trim();
  if(value.length<32)throw Object.assign(new Error('SOOP gateway lease secret is missing'),{status:503,code:'soop_gateway_lease_unavailable'});
  return value;
}

function signature(payload,secret){
  return crypto.createHmac('sha256',secret).update(`byeollog-soop-lease-v${LEASE_VERSION}\0${payload}`).digest('base64url');
}

export function issueSoopGatewayLease({workspaceId,broadcasterId,instanceId,expiresAt},environment=process.env){
  const workspace=clean(workspaceId,36).toLowerCase(),broadcaster=normalizeSoopBroadcasterId(broadcasterId),instance=clean(instanceId,160);
  const expiration=Math.trunc(Number(expiresAt));
  if(!UUID.test(workspace)||!broadcaster||!instance||!Number.isSafeInteger(expiration)){
    throw Object.assign(new Error('SOOP gateway lease claims are invalid'),{status:400,code:'invalid_soop_gateway_lease'});
  }
  const payload=Buffer.from(JSON.stringify({v:LEASE_VERSION,w:workspace,b:broadcaster,i:instance,e:expiration}),'utf8').toString('base64url');
  return `${payload}.${signature(payload,secretFor(environment))}`;
}

export function verifySoopGatewayLease(token,environment=process.env,{now=Date.now()}={}){
  const [payload,supplied,...rest]=String(token||'').split('.');
  if(!payload||!supplied||rest.length){
    throw Object.assign(new Error('SOOP gateway lease is missing'),{status:409,code:'soop_gateway_lease_missing'});
  }
  const expected=signature(payload,secretFor(environment));
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){
    throw Object.assign(new Error('SOOP gateway lease signature is invalid'),{status:409,code:'soop_gateway_lease_invalid'});
  }
  let claims;
  try{claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))}catch{
    throw Object.assign(new Error('SOOP gateway lease payload is invalid'),{status:409,code:'soop_gateway_lease_invalid'});
  }
  const workspaceId=clean(claims?.w,36).toLowerCase(),broadcasterId=normalizeSoopBroadcasterId(claims?.b),instanceId=clean(claims?.i,160),expiresAt=Math.trunc(Number(claims?.e));
  if(claims?.v!==LEASE_VERSION||!UUID.test(workspaceId)||!broadcasterId||!instanceId||!Number.isSafeInteger(expiresAt)){
    throw Object.assign(new Error('SOOP gateway lease payload is invalid'),{status:409,code:'soop_gateway_lease_invalid'});
  }
  if(expiresAt<=Number(now)){
    throw Object.assign(new Error('SOOP gateway lease expired'),{status:409,code:'soop_gateway_lease_expired'});
  }
  return Object.freeze({workspaceId,broadcasterId,instanceId,expiresAt});
}

export function normalizeSoopRoomIdentity(value){
  const broadcasterId=normalizeSoopBroadcasterId(value?.bjId),chatNumber=Number(value?.chatNumber);
  if(!broadcasterId||!Number.isSafeInteger(chatNumber)||chatNumber<=0)return null;
  return Object.freeze({broadcasterId,chatNumber});
}

export function assertSoopGatewayOwnership({body,claims,requireRoom=false}){
  const workspaceId=clean(body?.workspaceId,36).toLowerCase(),instanceId=clean(body?.instanceId,160);
  if(workspaceId!==claims.workspaceId||instanceId!==claims.instanceId){
    throw Object.assign(new Error('SOOP gateway lease does not own this request'),{status:409,code:'soop_gateway_lease_scope_mismatch'});
  }
  const room=normalizeSoopRoomIdentity(body?.room);
  if(requireRoom&&!room){
    throw Object.assign(new Error('SOOP room identity is not ready'),{status:409,code:'soop_room_identity_missing'});
  }
  if(room&&room.broadcasterId!==claims.broadcasterId){
    throw Object.assign(new Error('SOOP room belongs to another broadcaster'),{status:409,code:'soop_room_owner_mismatch'});
  }
  return {workspaceId:claims.workspaceId,instanceId:claims.instanceId,broadcasterId:claims.broadcasterId,room};
}
