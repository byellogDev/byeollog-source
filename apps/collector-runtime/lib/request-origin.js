/**
 * Browser-origin guard for public state-changing endpoints.
 * Missing Origin is allowed for legacy/native clients; when browsers provide it,
 * it must exactly match the host that received the request.
 */
export function isTrustedMutationOrigin(req){
  const fetchSite=String(req.headers?.['sec-fetch-site']||'').trim().toLowerCase();
  if(fetchSite==='cross-site')return false;

  const origin=String(req.headers?.origin||'').trim();
  if(!origin)return true;
  if(origin==='null')return false;

  const forwardedHost=String(req.headers?.['x-forwarded-host']||'').split(',')[0].trim();
  const host=forwardedHost||String(req.headers?.host||'').trim();
  const forwardedProto=String(req.headers?.['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  const proto=forwardedProto||((req.socket?.encrypted)?'https':'http');
  if(!host||!['http','https'].includes(proto))return false;
  try{return new URL(origin).origin===`${proto}://${host}`}
  catch{return false}
}

export function isJsonRequest(req){
  return String(req.headers?.['content-type']||'').toLowerCase().split(';',1)[0].trim()==='application/json';
}
