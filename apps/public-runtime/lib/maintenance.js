export const WRITE_MAINTENANCE_MODE='write-blocked-v1';

const SAFE_METHODS=new Set(['GET','HEAD','OPTIONS']);

export function isWriteMaintenanceActive(environment=process.env){
  return String(environment?.BYEOLLOG_MAINTENANCE_MODE||'').trim()===WRITE_MAINTENANCE_MODE;
}

export function isMaintenanceWriteRequest(req,{additionalWriteRequest}={}){
  const method=String(req?.method||'GET').toUpperCase();
  if(!SAFE_METHODS.has(method))return true;
  return typeof additionalWriteRequest==='function'&&additionalWriteRequest(req)===true;
}

/**
 * Reversible outer write gate for the production maintenance window.
 *
 * The exact mode string avoids accidentally enabling the gate with a generic
 * truthy value. Every deployment must prove the response header and 503
 * behavior before a database maintenance step begins.
 */
export function rejectMaintenanceWrite(req,res,options={}){
  if(!isWriteMaintenanceActive())return false;
  res.setHeader('X-Byeollog-Maintenance',WRITE_MAINTENANCE_MODE);
  if(!isMaintenanceWriteRequest(req,options))return false;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Retry-After','120');
  res.status(503).json({
    message:'현재 안전 점검 중입니다. 잠시 후 다시 시도해주세요.',
    code:'maintenance_write_blocked'
  });
  return true;
}
