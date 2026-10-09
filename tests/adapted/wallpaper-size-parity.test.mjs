import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {groupWallpaperTiles,layoutWallpaperGroups} from '../../apps/web/lib/wallpaper-layout.js';

const renderer=readFileSync(auditURL('../../BYEOLLOG_AGENT_DEV_v07022/ByeollogOverlayService.cs',import.meta.url),'utf8');
const html=readFileSync(auditURL('../../BYEOLLOG_AGENT_DEV_v07022/Ui/wallpaper_editor.html',import.meta.url),'utf8');
function context(){
  const ctx=vm.createContext({state:{wallpaperDraft:[]}});
  vm.runInContext(readFileSync(new URL('../../apps/windows-agent/Ui/wallpaper-hidden.js',import.meta.url),'utf8'),ctx);
  const constants=renderer.split(/\r?\n/).filter(l=>/^\s*const WALLPAPER_(CARD_WIDTH|MIN_WIDTH|CANVAS_MARGIN)\s*=/.test(l)).join('\n');
  vm.runInContext(constants+'\n'+renderer.slice(renderer.indexOf('    function wallpaperColumns('),renderer.indexOf('    function renderWallpaper(state)')),ctx);
  vm.runInContext(html.split(/\r?\n/).filter(l=>/^function (wallpaperDraftBaseCardHeight|layoutWallpaperDraftGroup|fitWallpaperDraftGroup|applyWallpaperWidthRule)\(/.test(l)).join('\n'),ctx);
  return ctx;
}
const makeTiles=(amount,count=1,layout=null,kind='donation')=>Array.from({length:count},(_,i)=>({id:`fixture-${amount}-${i}`,amount,displayKind:kind,groupKey:`${kind}-${amount}`,source:'signature',imageUrl:'fixture',layout}));
for(const amount of [33,152,330])for(const width of [80,240,360,480])for(const count of [1,2,6,15]){
  test(`saved ${amount} range: ${width}px stays equal across server/editor/OBS (${count} cards)`,()=>{
    const ctx=context(),tiles=makeTiles(amount,count),rules=[{min:amount,max:amount,width}];
    const group=layoutWallpaperGroups(groupWallpaperTiles(tiles),{sizeRanges:rules})[0];
    ctx.tiles=tiles;ctx.rules=rules;ctx.draft=structuredClone(group);
    const obs=vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)[0]',ctx);
    assert.equal(group.cardWidth,width);assert.equal(obs.cards[0].width,width);
    const editor=vm.runInContext('fitWallpaperDraftGroup(draft)',ctx);
    assert.equal(editor.cardWidth,width);assert.ok(editor.x+editor.width<=1920);assert.ok(editor.y+editor.height<=1080);
    // Persist editor layout, grow by one donation, then reload both renderers.
    const layout={x:editor.x,y:editor.y,width:editor.width,height:editor.height,columns:editor.layoutColumns,rows:editor.layoutRows,nextSide:'right'};
    ctx.tiles=makeTiles(amount,count+1,layout);
    const saved=layoutWallpaperGroups(groupWallpaperTiles(ctx.tiles),{sizeRanges:rules})[0];
    const live=vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)[0]',ctx);
    assert.equal(live.cards[0].width,saved.cardWidth,'new donation agrees with saved layout');
  });
}
test('existing explicit 300px manual layout wins over a 360px automatic rule',()=>{
  const ctx=context();ctx.tiles=makeTiles(330,2,{x:0,y:0,width:600,height:340,columns:2,rows:2,nextSide:'right'});ctx.rules=[{min:330,max:330,width:360}];
  assert.equal(vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)[0].cards[0].width',ctx),300);
});
test('new automatic groups keep fixed width even when other groups occupy the canvas',()=>{
  const ctx=context();ctx.tiles=[...makeTiles(33,1,{x:0,y:0,width:1500,height:900,columns:2,rows:1}),...makeTiles(330)];ctx.rules=[{min:330,max:330,width:360}];
  const server=layoutWallpaperGroups(groupWallpaperTiles(ctx.tiles),{sizeRanges:ctx.rules});
  const obs=vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)',ctx);
  assert.equal(server.find(g=>g.amount===330).cardWidth,360);assert.equal(obs.find(g=>g.amount===330).cards[0].width,360);
});
test('rules do not resize subscriptions, mismatched merged groups, or legacy snapshots',()=>{
  const ctx=context();ctx.rules=[{min:330,max:330,width:360}];
  for(const kind of ['subscription','challenge_success']){ctx.tiles=makeTiles(330,1,null,kind);assert.equal(vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)[0].cards[0].width',ctx),240)}
  ctx.tiles=makeTiles(330);assert.equal(vm.runInContext('wallpaperGroups(tiles,1920,1080)[0].cards[0].width',ctx),240);
  ctx.tiles=[...makeTiles(330),...makeTiles(331)].map(t=>({...t,groupKey:'merged'}));assert.equal(vm.runInContext('wallpaperGroups(tiles,1920,1080,rules)[0].cards[0].width',ctx),240);
});
