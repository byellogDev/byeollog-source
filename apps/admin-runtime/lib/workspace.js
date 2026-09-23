import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';

export const WORKSPACE_TABLES=new Set([
  'bangsel_tasks','bangsel_fan_stations','bangsel_fans','bangsel_roulette_rules',
  'bangsel_donations','bangsel_task_import_items','bangsel_collector_staging','bangsel_roulette_invalidations'
]);
export const q=v=>encodeURIComponent(String(v??''));
export const sha256=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LegacyWorkspaceConfigurationError extends Error{
  constructor(code,message){
    super(message);
    this.name='LegacyWorkspaceConfigurationError';
    this.code=code;
  }
}

export function configuredLegacyWorkspaceId(){
  const value=String(process.env.BYEOLLOG_LEGACY_WORKSPACE_ID||'').trim();
  if(!value){
    throw new LegacyWorkspaceConfigurationError(
      'legacy_workspace_id_not_configured',
      'BYEOLLOG_LEGACY_WORKSPACE_ID is required while legacy Collector authentication is enabled'
    );
  }
  if(!UUID_PATTERN.test(value)){
    throw new LegacyWorkspaceConfigurationError(
      'legacy_workspace_id_invalid',
      'BYEOLLOG_LEGACY_WORKSPACE_ID must be an exact UUID'
    );
  }
  return value.toLowerCase();
}
export function addWorkspaceFilter(path,workspaceId){
  if(!workspaceId)return path||'';
  const p=path||'';
  const join=p.includes('?')?'&':'?';
  return `${p}${join}workspace_id=eq.${q(workspaceId)}`;
}
export function withWorkspaceBody(body,workspaceId){
  if(!workspaceId)return body;
  if(Array.isArray(body))return body.map(x=>x&&typeof x==='object'?{...x,workspace_id:workspaceId}:x);
  return body&&typeof body==='object'?{...body,workspace_id:workspaceId}:body;
}
export async function legacyWorkspace(){
  const workspaceId=configuredLegacyWorkspaceId();
  const rows=await sb(
    'byeollog_workspaces',
    `?select=id,slug,display_name,status&id=eq.${q(workspaceId)}&status=eq.active&limit=2`
  );
  if(!Array.isArray(rows)||rows.length!==1||String(rows[0]?.id||'').toLowerCase()!==workspaceId){
    throw new LegacyWorkspaceConfigurationError(
      'legacy_workspace_not_active',
      'Configured legacy workspace does not resolve to exactly one active workspace'
    );
  }
  return rows[0];
}
export async function workspaceForSession(session){
  if(session?.workspace_id)return session.workspace_id;
  const legacy=await legacyWorkspace();
  return legacy?.id||null;
}
