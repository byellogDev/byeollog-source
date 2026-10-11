import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCollectionSettings,normalizeEventName,upboCollectionRequest} from '../apps/admin-runtime/lib/upbo-collection.js';
import {fetchAutomaticRouletteRules,readAutomaticRouletteRules,refreshAutomaticRouletteRules} from '../apps/admin-runtime/lib/weflab-collection-config.js';
const url='https://weflab.com/page/FixturePage';
const provider=(count=13)=>({result:'success',data:{checkbox:{item_alert_rouletteuse:'on'},donation:{item_roulette_donation:[{checkbox:{setup_roulette_use:'on',setup_roulette_double:'on'},text:{setup_alert_giftmin:'330',setup_alert_giftmax:'330'},select:{setup_roulette_doublecount:count}}]}}});
test('URL required for ON; invalid origins, embedded credentials and public links fail',()=>{
 for(const value of ['', 'https://evil.test/page/a','https://weflab.com@evil.test/page/a','https://weflab.com/user/a',url+'?extra=1'])assert.throws(()=>normalizeCollectionSettings({enabled:true,url:value}));
 assert.deepEqual(normalizeCollectionSettings({enabled:false,url:''}),{enabled:false,url:''});
 assert.deepEqual(normalizeEventName({amount:330,name:'  My event  '}),{amount:330,amountMax:330,name:'My event'});
});
test('provider configuration supplies total spins with no user registration; ambiguous settings fail',()=>{
 assert.deepEqual(readAutomaticRouletteRules(provider()),[{amount:330,amountMax:330,spins:13}]);
 assert.throws(()=>readAutomaticRouletteRules(provider(0)));
 const p=provider();p.data.donation.item_roulette_donation.push(p.data.donation.item_roulette_donation[0]);assert.throws(()=>readAutomaticRouletteRules(p),/overlap/);
 const range=provider();range.data.donation.item_roulette_donation[0].checkbox.setup_roulette_range='on';assert.throws(()=>readAutomaticRouletteRules(range),/unsupported/);
});
test('configuration read validates account and never requests a roulette draw',async()=>{
 const calls=[];const context={type:'page',pageid:'alert',platform:{afreeca:{id:'fixture_owner'}},idx:1,preset:0,dir:'fixture',config:{ver:'fixture'}};
 const fetchImpl=async(u,o)=>{calls.push([u,o]);return new Response(calls.length===1?'const loginData = '+JSON.stringify(context)+';':JSON.stringify(provider()))};
 assert.equal((await fetchAutomaticRouletteRules(url,'fixture_owner',{fetchImpl}))[0].spins,13);
 assert.equal(calls[1][1].body.get('type'),'page_load');assert.equal(calls[0][1].redirect,'error');
 await assert.rejects(fetchAutomaticRouletteRules(url,'another_owner',{fetchImpl:async()=>new Response('const loginData = '+JSON.stringify(context)+';')}),/account/);
});
test('failed verification cannot turn ON or leak provider payload; OFF makes no provider call',async()=>{
 let writes=0;const sb=async route=>{if(route==='byeollog_workspaces')return [{soop_id:'fixture_owner'}];writes++;return {enabled:false,url,names:[]}};
 const options={sb,workspaceId:'fixture',userId:'owner',method:'POST',body:{enabled:true,url},fetchRules:async()=>{throw Error('private payload')}};
 const failed=await upboCollectionRequest(options);assert.equal(failed.status,400);assert.equal(writes,0);assert.doesNotMatch(failed.body.message,/private payload/);
 assert.equal((await upboCollectionRequest({...options,body:{enabled:false,url}})).status,200);assert.equal(writes,1);
});
test('names API never registers spin counts and sends only authorized workspace scope',async()=>{
 let write;
 await upboCollectionRequest({workspaceId:'authorized',userId:'manager',method:'POST',query:{kind:'name'},body:{amount:330,name:'Custom',workspaceId:'other',spins:999},sb:async(_r,_p,o)=>{write=o.body;return {names:[]}}});
 assert.equal(write.p_workspace_id,'authorized');assert.deepEqual(write.p_request,{action:'name_save',amount:330,amountMax:330,name:'Custom'});
});
test('OFF and warm cache avoid provider requests',async()=>{
 for(const state of [{requestedEnabled:false,url},{requestedEnabled:true,url,refreshAllowed:false}])await refreshAutomaticRouletteRules('fixture',{sb:async()=>state,fetchImpl:()=>assert.fail('unexpected fetch')});
});
