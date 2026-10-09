import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = path => fs.readFileSync(new URL('../../apps/windows-agent/' + path, import.meta.url),'utf8');
const html = read('Ui/wallpaper_editor.html'), renderer = read('ByeollogOverlayService.cs');
function context() {
  const ctx=vm.createContext({});
  for(const file of ['wallpaper-hidden.js','wallpaper-detached.js'])vm.runInContext(read('Ui/'+file),ctx);
  vm.runInContext(html.slice(html.indexOf('const localWallpaperLayout='),html.indexOf('async function request(')),ctx);
  vm.runInContext(html.split(/\r?\n/).filter(l=>/^function (wallpaperDraftBaseCardHeight|layoutWallpaperDraftGroup|fitWallpaperDraftGroup)\(/.test(l)).join('\n'),ctx);
  const constants=renderer.split(/\r?\n/).filter(l=>/^\s*const WALLPAPER_(CARD_WIDTH|MIN_WIDTH|CANVAS_MARGIN)\s*=/.test(l)).join('\n');
  vm.runInContext(constants+'\n'+renderer.slice(renderer.indexOf('    function wallpaperColumns('),renderer.indexOf('    function renderWallpaper(state)')),ctx);
  return ctx;
}
const cards=(layout=null)=>Array.from({length:7},(_,i)=>({id:'card-'+i,amount:119,groupKey:'fixture',source:'soop',imageUrl:'fixture.png',actorName:'Fixture',layout:i===0?layout:null,receivedAt:`2026-10-09T10:00:0${i}Z`}));
const plain = value => JSON.parse(JSON.stringify(value));
const shape = groups => plain(groups.map(g=>({id:g.id,x:g.x,y:g.y,width:g.width,height:g.height,cards:g.cards.map(c=>({id:c.id,x:c.x,y:c.y,width:c.width,height:c.height}))})));
function render(ctx,tiles,hidden={}) {
  ctx.input={localRulesLayout:true,tiles,hiddenCards:{cards:hidden}};
  const editor=vm.runInContext('applyLocalWallpaperLayout(input)',ctx);
  const overlay=vm.runInContext('wallpaperGroups(input.tiles,1920,1080,[],input.hiddenCards)',ctx);
  const local=shape(editor.groups),obs=shape(overlay);
  if(!tiles.some(t=>t.layout)){for(const groups of [local,obs])for(const group of groups){delete group.x;delete group.y;}}
  assert.deepEqual(local,obs,'editor/overlay stack geometry');
  return editor;
}
for(const nextSide of ['left','right']) test(`hidden bottom/middle/top cards leave no stack gaps (${nextSide})`,()=>{
  const ctx=context(),layout={x:150,y:200,width:720,height:410,columns:3,rows:5,nextSide},tiles=cards(layout);
  const before=JSON.stringify(tiles),hidden={'card-0':{},'card-2':{},'card-6':{}};
  const result=render(ctx,tiles,hidden),group=result.groups[0];
  assert.deepEqual(plain(group.cards.map(c=>c.id)),['card-1','card-3','card-4','card-5']);
  assert.deepEqual(plain(group.tileIds),tiles.map(c=>c.id),'hidden members retain layout write identity');
  const expected=render(ctx,tiles.filter(c=>!Object.hasOwn(hidden,c.id)).map((c,i)=>({...c,layout:i===0?layout:null})));
  assert.deepEqual(shape(result.groups),shape(expected.groups),'same positions as a stack containing only visible cards');
  assert.equal(JSON.stringify(tiles),before);
  assert.deepEqual(shape(render(ctx,tiles).groups),shape(render(ctx,cards(layout)).groups),'restore original order and geometry');
});
test('all-hidden group occupies no auto-placement area; later donation starts a visible stack',()=>{
  const ctx=context(),tiles=cards(),hidden=Object.fromEntries(tiles.map(t=>[t.id,{}]));
  assert.equal(render(ctx,tiles,hidden).groups.length,0);
  const newcomer={...tiles[0],id:'new'};
  const result=render(ctx,[...tiles,newcomer],hidden);
  assert.deepEqual(shape(result.groups),shape(render(ctx,[newcomer]).groups));
  assert.equal(result.tiles.length,8,'restore source remains available');
});
test('merged and compact groups size and count only visible members',()=>{
  const ctx=context(),tiles=cards().map((t,i)=>({...t,amount:110+i,mergeRange:{min:110,max:120},imageUrl:null}));
  const hidden={'card-1':{},'card-3':{},'card-5':{}};
  const result=render(ctx,tiles,hidden),expected=render(ctx,tiles.filter(t=>!Object.hasOwn(hidden,t.id)));
  assert.deepEqual(shape(result.groups),shape(expected.groups));
});
test('legacy grouped snapshot also compacts without losing hidden layout members',()=>{
  const ctx=context(),layout={x:0,y:0,width:480,height:410,columns:2,rows:5,nextSide:'right'};
  const baseline=render(ctx,cards(layout));
  ctx.input={groups:baseline.groups,hiddenCards:{cards:{'card-2':{},'card-3':{}}}};
  const before=JSON.stringify(ctx.input.groups);
  const result=vm.runInContext('applyLocalWallpaperLayout(input)',ctx);
  assert.equal(result.groups[0].cards.length,5);assert.equal(result.groups[0].tileIds.length,7);
  assert.equal(result.groups[0].cards[2].y,result.groups[0].cards[1].y-result.groups[0].rowStep);
  assert.equal(JSON.stringify(ctx.input.groups),before);
});
