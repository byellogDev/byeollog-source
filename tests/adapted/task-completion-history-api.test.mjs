import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler from '../../apps/admin-runtime/handlers/data.js';
import {createSessionToken} from '../../apps/admin-runtime/lib/auth.js';
test('history API requires live membership, enforces own workspace and cannot write',async()=>{
 const own='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';let active=true,reads=0;
 const server=http.createServer((req,res)=>{
  const url=auditURL(req.url,'http://localhost');let rows=[];
  if(url.pathname.endsWith('/byeollog_workspace_members'))rows=active?[{role:'owner',workspace_id:own,web_session_epoch:0}]:[];
  else if(url.pathname.endsWith('/byeollog_workspaces'))rows=[{id:own,status:'active'}];
  else{assert.equal(url.pathname,'/rest/v1/byeollog_task_completion_history');assert.equal(url.searchParams.get('workspace_id'),'eq.'+own);assert.equal(url.searchParams.get('limit'),'51');reads++}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const keys=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{SUPABASE_URL:'http://127.0.0.1:'+server.address().port,SUPABASE_SECRET_KEY:'synthetic',SUPABASE_SERVICE_ROLE_KEY:'synthetic',SESSION_SECRET:'local-test-only-session-secret-'.repeat(2)});
 const call=async(method='GET',signed=true)=>{
  const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(body){this.body=body;return this},end(){}};
  const token=createSessionToken({workspace_id:own,user_id:other,role:'owner'});
  await handler({method,query:{operation:'task-completion-history',workspace_id:other,table:'bangsel_tasks'},headers:signed?{cookie:'bangsel_admin_session='+token}:{}},res);return res;
 };
 try{
  assert.equal((await call('GET',false)).code,401);assert.equal(reads,0);
  const ok=await call();assert.equal(ok.code,200);assert.equal(ok.headers['Cache-Control'],'no-store, private');assert.equal(reads,1);
  for(const method of ['POST','PATCH','DELETE'])assert.equal((await call(method)).code,405);
  active=false;assert.equal((await call()).code,401);assert.equal(reads,1);
 }finally{await new Promise(resolve=>server.close(resolve));for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
});
