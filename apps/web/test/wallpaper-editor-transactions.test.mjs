import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createWallpaperEditSession} from '../lib/wallpaper-edit-session.js';
import {wallpaperEditorTransactionsScript} from '../lib/wallpaper-editor-transactions.js';
import {runAgentWallpaperControl} from '../lib/agent-wallpaper-control.js';
import {loadWallpaperState} from '../lib/wallpaper-service.js';

test('edit session rejects delayed reads and overlapping commands, releases after failure',()=>{
  const session=createWallpaperEditSession(),read=session.readTicket();
  const command=session.begin('merge');
  assert.throws(()=>session.begin('size'));assert.equal(session.accepts(read,{revision:9},{revision:10}),false);
  session.finish(command);assert.equal(session.accepts(read,{revision:9},{revision:10}),false);
  const fresh=session.readTicket();assert.equal(session.accepts(fresh,{revision:10},{revision:9}),false);
  assert.equal(session.accepts(fresh,{revision:10},{revision:11}),true);
});

function context(request){
  const messages=[];
  const state={wallpaper:{revision:9,groups:[],settingsProtocol:2},wallpaperDraft:[],wallpaperEditing:false};
  const ctx=vm.createContext({state,wallpaperEditSession:createWallpaperEditSession(),localWallpaperEditor:true,
    request,$:()=>null,renderWallpaperCatalog(){},renderWallpaperSessions(){},renderWallpaper(){},
    initializeWallpaperEditor(){},rebaseWallpaperDraft(){},flushWallpaperEdits:async()=>true,
    status:(...args)=>messages.push(args),WALLPAPER_LAYOUT_SAVE_PROTOCOL:3});
  vm.runInContext(wallpaperEditorTransactionsScript,ctx);
  return {ctx,state,messages};
}

test('merge conflict reloads state once, preserves typed input, does not repeat mutation',async()=>{
  const calls=[];const {ctx,state}=context(async(op,options)=>{calls.push([op,options]);if(options)throw Object.assign(Error('conflict'),{status:409});return {revision:10,groups:[]}});
  state.wallpaperSizeDraft=[{min:1,max:9,width:240}];
  assert.equal(await ctx.commitWallpaperSetting('save-merge-rules',{mergeRules:[]},'status','saved'),false);
  assert.equal(calls.filter(x=>x[1]).length,1);assert.equal(calls[1][0],'wallpaper-refresh');
  assert.equal(state.wallpaper.revision,10);assert.equal(state.wallpaperSizeDraft.length,1);assert.equal(ctx.wallpaperEditSession.busy,false);
});

test('commit receipt plus unavailable snapshot reports saved and retains previous complete state',async()=>{
  const {ctx,state,messages}=context(async(op,options)=>{if(options)return {committed:true,revision:10,refreshPending:true};throw Error('offline')});
  assert.equal(await ctx.commitWallpaperSetting('save-merge-rules',{mergeRules:[]},'status','saved'),true);
  assert.equal(state.wallpaper.revision,9);assert.equal(state.wallpaperNeedsRefresh,true);
  assert.match(messages.at(-1)[1],/설정은 저장됐습니다/);assert.notEqual(messages.at(-1)[2],'error');
});

test('size preflight failure never sends a write and leaves original draft intact',async()=>{
  let requests=0;const {ctx,state}=context(async()=>{requests++;});
  state.wallpaperDraft=[{id:'fixture',x:10,cards:[]}];const original=state.wallpaperDraft;
  ctx.applyWallpaperWidthRule=()=>{state.wallpaperDraft[0].x=80;throw Error('cannot fit')};
  await ctx.commitWallpaperSetting('save-size-rules',()=>ctx.prepareWallpaperSizeChange([{min:1,max:9,width:480}]),'status','saved');
  assert.equal(requests,0);assert.equal(state.wallpaperDraft,original);assert.equal(original[0].x,10);
});

test('layout backup receipt avoids a full-state read; legacy request retains full response',async()=>{
  let reads=0,rpcs=0;
  const args={workspaceId:'fixture',userId:'fixture',sbImpl:async()=>{rpcs++;return 10},loadStateImpl:async()=>{reads++;return {revision:10,groups:[]}}};
  const body={action:'save-layout',layoutSaveProtocol:3,expectedRevision:9,tiles:[]};
  const ack=await runAgentWallpaperControl({...args,body:{...body,responseMode:'receipt'}});
  assert.deepEqual(ack,{ok:true,committed:true,revision:10});assert.equal(reads,0);
  const legacy=await runAgentWallpaperControl({...args,body});assert.ok(Array.isArray(legacy.groups));assert.equal(reads,1);assert.equal(rpcs,2);
});

test('new settings client receives committed receipt when post-save state read fails',async()=>{
  let writes=0;const next=await runAgentWallpaperControl({workspaceId:'fixture',userId:'fixture',body:{action:'save-merge-rules',expectedRevision:9,mergeRules:[],responseMode:'state-or-receipt'},sbImpl:async()=>{writes++;return 10},loadStateImpl:async()=>{throw Error('read failed')}});
  assert.equal(writes,1);assert.deepEqual(next,{ok:true,committed:true,revision:10,refreshPending:true});
});

test('settings read failures fail closed rather than return an empty editable rule set',async()=>{
  await assert.rejects(loadWallpaperState('fixture',{authorizedUserId:'fixture',sbImpl:async table=>{if(table==='byeollog_wallpaper_user_settings')throw Error('settings unavailable');return []}}),/settings unavailable/);
});

test('size plus layout uses a single atomic RPC and preserves legacy size-only requests',async()=>{
  const calls=[];const args={workspaceId:'fixture',userId:'fixture',sbImpl:async(...args)=>{calls.push(args);return 10},loadStateImpl:async()=>({revision:10,groups:[]})};
  const body={action:'save-size-rules',expectedRevision:9,sizeRules:[]};
  await runAgentWallpaperControl({...args,body:{...body,layoutSaveProtocol:3,layoutTiles:[]}});
  assert.equal(calls[0][0],'rpc/save_wallpaper_size_and_layout_v1');assert.equal(calls.length,1);
  await runAgentWallpaperControl({...args,body});assert.equal(calls[1][0],'rpc/save_wallpaper_size_rules_v1');
});

test('a failed auto save is attempted once by the flush operation',async()=>{
  const html=readFileSync(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  const source=html.split(/\r?\n/).find(line=>line.startsWith('async function flushWallpaperEdits('));
  let attempts=0;const ctx=vm.createContext({state:{wallpaperEditing:true,wallpaperSavePending:true},flushWallpaperAutoSave:async()=>{attempts++;return false}});
  vm.runInContext(source,ctx);await assert.rejects(ctx.flushWallpaperEdits());assert.equal(attempts,1);
});
