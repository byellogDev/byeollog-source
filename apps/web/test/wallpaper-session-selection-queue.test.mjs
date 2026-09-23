import {createWallpaperEditSession} from '../lib/wallpaper-edit-session.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const waitUntil=async(predicate)=>{for(let attempt=0;attempt<100;attempt++){if(predicate())return;await wait(20)}assert.fail('timed out waiting for queued selection')};

test('rapid broadcast-session toggles are coalesced and saved in order',async()=>{
  const source=await readFile(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  const selectSource=source.match(/^function selectWallpaperSession\(.*$/m)?.[0];
  const equalitySource=source.match(/^function sameWallpaperSessionSelection\(.*$/m)?.[0];
  const flushSource=source.match(/^async function flushWallpaperSessionSelection\(.*$/m)?.[0];
  assert.ok(selectSource&&equalitySource&&flushSource,'session selection functions must remain extractable');

  const calls=[],pending=[];
  let active=0,maxActive=0;
  const context={
    state:{
      wallpaper:{selectedSessionIds:[]},wallpaperEditing:false,wallpaperPointer:null,
      wallpaperVisibilitySaving:false,wallpaperSessionSaving:false,wallpaperSessionDesiredIds:null,
      wallpaperSessionMutationVersion:0,wallpaperSessionAppliedVersion:0,wallpaperSessionSavePromise:null
    },
    request:async(operation,options)=>{
      if(!options)return context.state.wallpaper;
      const sessionIds=JSON.parse(options.body).sessionIds;
      calls.push(sessionIds);
      active++;maxActive=Math.max(maxActive,active);
      return new Promise(resolve=>pending.push({sessionIds,resolve:value=>{active--;resolve(value)}}));
    },
    flushWallpaperEdits:async()=>true,
    renderWallpaperSessions:()=>{},renderWallpaperCatalog:()=>{},renderWallpaper:()=>{},
    rebaseWallpaperDraft:()=>{},initializeWallpaperEditor:()=>{},status:()=>{},
    $:()=>({disabled:false}),console,setTimeout
  };
  vm.createContext(context);
  vm.runInContext(`${selectSource}\n${equalitySource}\n${flushSource}`,context);

  context.selectWallpaperSession('session-a',true);
  await nextTurn();
  context.selectWallpaperSession('session-b',true);
  context.selectWallpaperSession('session-a',false);
  assert.deepEqual(Array.from(context.state.wallpaperSessionDesiredIds),['session-b']);
  assert.equal(calls.length,0);

  await waitUntil(()=>calls.length===1);
  assert.deepEqual(calls,[['session-b']]);

  const drain=context.state.wallpaperSessionSavePromise;
  context.selectWallpaperSession('session-a',true);
  pending.shift().resolve({selectedSessionIds:['session-b']});
  await waitUntil(()=>calls.length===2);
  assert.deepEqual(calls,[['session-b'],['session-b','session-a']]);
  pending.shift().resolve({selectedSessionIds:['session-b','session-a']});
  await drain;

  assert.equal(maxActive,1);
  assert.deepEqual(context.state.wallpaper.selectedSessionIds,['session-b','session-a']);
  assert.equal(context.state.wallpaperSessionDesiredIds,null);
  assert.equal(context.state.wallpaperSessionSaving,false);
  assert.equal(context.state.wallpaperSessionSavePromise,null);
});

test('a mismatched selection response cannot silently replace the requested checkboxes',async()=>{
  const source=await readFile(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  const selectSource=source.match(/^function selectWallpaperSession\(.*$/m)?.[0];
  const equalitySource=source.match(/^function sameWallpaperSessionSelection\(.*$/m)?.[0];
  const flushSource=source.match(/^async function flushWallpaperSessionSelection\(.*$/m)?.[0];
  assert.ok(selectSource&&equalitySource&&flushSource,'session selection functions must remain extractable');

  const statuses=[];
  let requestCount=0;
  const context={
    state:{
      wallpaper:{selectedSessionIds:['session-a']},wallpaperEditing:false,wallpaperPointer:null,
      wallpaperVisibilitySaving:false,wallpaperSessionSaving:false,wallpaperSessionDesiredIds:null,
      wallpaperSessionMutationVersion:0,wallpaperSessionAppliedVersion:0,wallpaperSessionSavePromise:null
    },
    request:async(operation,options)=>{
      requestCount++;
      if(options)return {selectedSessionIds:['session-a']};
      return {selectedSessionIds:['session-a']};
    },
    flushWallpaperEdits:async()=>true,
    renderWallpaperSessions:()=>{},renderWallpaperCatalog:()=>{},renderWallpaper:()=>{},
    rebaseWallpaperDraft:()=>{},initializeWallpaperEditor:()=>{},status:(id,message,kind)=>statuses.push({message,kind}),
    $:()=>({disabled:false}),console,setTimeout
  };
  vm.createContext(context);
  vm.runInContext(`${selectSource}\n${equalitySource}\n${flushSource}`,context);

  context.selectWallpaperSession('session-a',false);
  await context.state.wallpaperSessionSavePromise;

  assert.equal(requestCount,2);
  assert.equal(context.state.wallpaperSessionDesiredIds,null);
  assert.equal(context.state.wallpaperSessionAppliedVersion,1);
  assert.equal(context.state.wallpaper.selectedSessionIds[0],'session-a');
  assert.equal(statuses.at(-1).kind,'error');
  assert.match(statuses.at(-1).message,/다시 확인하지 못했습니다/);
});

test('a throttled selection is rolled back to the authoritative local state instead of leaving fake checkboxes',async()=>{
  const source=await readFile(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  const selectSource=source.match(/^function selectWallpaperSession\(.*$/m)?.[0];
  const equalitySource=source.match(/^function sameWallpaperSessionSelection\(.*$/m)?.[0];
  const flushSource=source.match(/^async function flushWallpaperSessionSelection\(.*$/m)?.[0];
  const statuses=[];
  let postCount=0,renders=0;
  const authoritative={selectedSessionIds:['session-a'],groups:[{id:'group-a'}]};
  const context={
    state:{
      wallpaper:authoritative,wallpaperEditing:false,wallpaperPointer:null,
      wallpaperVisibilitySaving:false,wallpaperSessionSaving:false,wallpaperSessionDesiredIds:null,
      wallpaperSessionMutationVersion:0,wallpaperSessionAppliedVersion:0,wallpaperSessionSavePromise:null
    },
    request:async(operation,options)=>{
      if(options){postCount++;const error=new Error('풍벽지 요청이 잠시 많습니다.');error.code='rate_limited';throw error}
      return authoritative;
    },
    flushWallpaperEdits:async()=>true,
    renderWallpaperSessions:()=>{},renderWallpaperCatalog:()=>{},renderWallpaper:()=>{renders++},
    rebaseWallpaperDraft:()=>{},initializeWallpaperEditor:()=>{},status:(id,message,kind)=>statuses.push({message,kind}),
    $:()=>({disabled:false}),console,setTimeout
  };
  vm.createContext(context);
  vm.runInContext(`${selectSource}\n${equalitySource}\n${flushSource}`,context);

  context.selectWallpaperSession('session-a',false);
  await context.state.wallpaperSessionSavePromise;

  assert.equal(postCount,1);
  assert.equal(context.state.wallpaperSessionDesiredIds,null);
  assert.deepEqual(context.state.wallpaper.selectedSessionIds,['session-a']);
  assert.equal(renders,1);
  assert.equal(statuses.at(-1).kind,'error');

  context.selectWallpaperSession('session-b',true);
  assert.deepEqual(Array.from(context.state.wallpaperSessionDesiredIds),['session-a','session-b']);
});

test('a refresh started before a session click cannot restore the old selection',async()=>{
  const source=await readFile(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');
  const refreshSource=source.match(/^async function refreshWallpaperLive\(\).*$/m)?.[0];
  assert.ok(refreshSource,'live refresh function must remain extractable');

  let resolveRefresh;
  let renders=0;
  const context={
    localWallpaperEditor:true,wallpaperRefreshInFlight:false,wallpaperSettingsBusy:()=>false,wallpaperEditSession:createWallpaperEditSession(),
    document:{visibilityState:'visible'},
    state:{
      wallpaper:{revision:1,displayKey:'selected-a',selectedSessionIds:['session-a']},
      wallpaperPointer:null,wallpaperSaveInFlight:false,wallpaperSessionSaving:false,
      wallpaperSessionMutationVersion:0,wallpaperEditing:false,wallpaperSavePending:false
    },
    request:()=>new Promise(resolve=>{resolveRefresh=resolve}),
    rebaseWallpaperDraft:()=>{},initializeWallpaperEditor:()=>{},
    renderWallpaper:()=>{renders++},console
  };
  vm.createContext(context);
  vm.runInContext(refreshSource,context);

  const refresh=context.refreshWallpaperLive();
  await nextTurn();
  context.state.wallpaperSessionMutationVersion++;
  resolveRefresh({revision:2,displayKey:'stale-a',selectedSessionIds:['session-a']});
  await refresh;

  assert.equal(context.state.wallpaper.displayKey,'selected-a');
  assert.deepEqual(context.state.wallpaper.selectedSessionIds,['session-a']);
  assert.equal(renders,0);
});
