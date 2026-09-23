import {sb} from './supabase-rest.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
export async function loadTaskCompletionHistory(workspaceId,cursor,{sbImpl=sb}={}){
 if(!uuid.test(workspaceId||''))throw Object.assign(new Error('Workspace not resolved'),{status:403});
 const params=new URLSearchParams({workspace_id:'eq.'+workspaceId,select:'id,task_id,fan,fan_soop_id,event,type,before_done,after_done,before_total,after_total,change_kind,occurred_at',order:'occurred_at.desc,id.desc',limit:'51'});
 if(cursor){
  let parsed;
  try{if(typeof cursor!=='string'||cursor.length>200)throw Error();parsed=JSON.parse(cursor);if(!uuid.test(parsed.id)||!timestamp.test(parsed.at)||!Number.isFinite(Date.parse(parsed.at)))throw Error()}
  catch{throw Object.assign(new Error('조회 위치가 올바르지 않습니다. 새로고침해주세요.'),{status:400})}
  params.set('or',`(occurred_at.lt.${parsed.at},and(occurred_at.eq.${parsed.at},id.lt.${parsed.id}))`);
 }
 const rows=await sbImpl('byeollog_task_completion_history','?'+params,{signal:AbortSignal.timeout(10000)});
 if(!Array.isArray(rows))throw new Error('Invalid history response');
 const items=rows.slice(0,50),last=items.at(-1);
 return {items,cursor:rows.length>50?{at:last.occurred_at,id:last.id}:null};
}
