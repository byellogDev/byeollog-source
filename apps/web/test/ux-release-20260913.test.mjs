import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {handleAgentSupport} from '../lib/agent-support.js';
import {getRouletteClassificationHtml} from '../lib/roulette-classification-html.js';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {normalizeRouletteAmountMapping} from '../lib/roulette-amount-mapping.js';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
test('all changed inline scripts compile including generated admin and viewer',async()=>{
  for(const html of [await read('../lib/admin-source.html'),await read('../bangsel_public_workspace_isolation.html'),getRouletteClassificationHtml('fixture'),getProductDashboardHtml('fixture','signatures'),await read('../../BYEOLLOG_AGENT_DEV_v07022/Ui/byeollog_ui.html'),await read('../../BYEOLLOG_AGENT_DEV_v07022/Ui/wallpaper_editor.html')]){
    for(const [,code] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(code);
    // Ignore templates in script bodies, but include static DOM after head scripts.
    const staticIds=[...html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
    assert.equal(new Set(staticIds).size,staticIds.length,'duplicate static id');
  }
});
test('range normalization is inclusive, legacy-safe, and rejects invalid maximums',()=>{
  assert.equal(normalizeRouletteAmountMapping({balloons:33,balloonsMax:100,rouletteName:'wheel'}).balloons_max,100);
  assert(!Object.hasOwn(normalizeRouletteAmountMapping({balloons:33,rouletteName:'legacy'}),'balloons_max'));
  for(const balloonsMax of [32,1.5,1e10,'bad'])assert.throws(()=>normalizeRouletteAmountMapping({balloons:33,balloonsMax,rouletteName:'wheel'}));
});
test('support validates authorization, beta phase, request shape, durable receipt and scoped author',async()=>{
  const body={workspaceId:'10000000-0000-4000-8000-000000000001',requestId:'20000000-0000-4000-8000-000000000002',message:'풍벽지가 표시되지 않습니다.',userId:'forged',streamerName:'forged'};
  const req={method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body};
  const res=()=>({code:0,body:null,setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return this}});
  let calls=0;const options={authorize:async()=>({status:200,user:{id:'verified'}}),rateLimit:async()=>false,sbImpl:async(name,query,{body:sent})=>{calls++;assert.equal(sent.p_user_id,'verified');assert.equal(sent.p_workspace_id,body.workspaceId);assert(!('streamerName'in sent));return {ok:true}}};
  let r=res();await handleAgentSupport(req,r,options);assert.equal(r.code,200);assert.equal(calls,1);
  r=res();await handleAgentSupport(req,r,{...options,env:{BYEOLLOG_FREE_BETA_SUPPORT_ENABLED:'false'}});assert.equal(r.code,410);
  r=res();await handleAgentSupport({...req,body:{...body,message:'x'}},r,options);assert.equal(r.code,400);
  r=res();await handleAgentSupport(req,r,{...options,authorize:async()=>({status:403})});assert.equal(r.code,403);assert.equal(calls,1);
  r=res();await handleAgentSupport(req,r,{...options,sbImpl:async()=>{throw {code:'PT429'}}});assert.equal(r.code,429);
});
