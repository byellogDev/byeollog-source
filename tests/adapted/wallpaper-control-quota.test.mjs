import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

test('unauthorized callers cannot spend workspace quota; authenticated and IP fences still apply',async()=>{
  const source=await readFile(auditURL('../api/login.js',import.meta.url),'utf8');
  const start=source.indexOf('async function handleAgentWallpaperControl(req,res){');
  const end=source.indexOf('\nasync function handleSoopWallpaperOverlayPage',start);
  assert.ok(start>=0&&end>start);
  const hits=new Map();let writes=0,authCalls=0;
  const context={UUID:/^[0-9a-f-]{36}$/,AbortSignal,isJsonRequest:()=>true,bearer:r=>r.token,bodyOf:r=>r.body,clientIp:r=>r.ip,
    isRateLimited:async(key,{limit})=>{const count=(hits.get(key)||0)+1;hits.set(key,count);return count>limit},
    authorizedAgentWorkspace:async token=>{authCalls++;return token==='valid'?{status:200,user:{id:'fixture'}}:{status:401}},
    runAgentWallpaperControl:async()=>{writes++;return {ok:true}},console};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const workspaceId='11111111-1111-4111-8111-111111111111';
  const body={workspaceId,control:{action:'select-sessions',sessionIds:[]}};
  async function call(token,ip='same-nat'){
    const res={status(code){this.code=code;return this},json(value){this.body=value;return this}};
    await context.handleAgentWallpaperControl({method:'POST',token,ip,body},res);return res.code;
  }
  for(let i=0;i<120;i++)assert.equal(await call('bad'),401);
  assert.equal(hits.has(`agent-wallpaper-control-v2:selection:${workspaceId}`),false);
  for(let i=0;i<120;i++)assert.equal(await call('valid'),200);
  assert.equal(await call('valid'),429);
  assert.equal(writes,120);
  hits.set('agent-wallpaper-preauth:attacker',1000);
  const before=authCalls;assert.equal(await call('bad','attacker'),429);assert.equal(authCalls,before);
});
