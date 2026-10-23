import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const sources=['apps/windows-agent/Ui/wallpaper_editor.html',...['web','admin-runtime','collector-runtime','public-runtime'].map(app=>`apps/${app}/lib/product-dashboard-html.js`)];
function context(source){
  const ctx=vm.createContext({state:{wallpaperDraft:[]},WALLPAPER_EDITOR_MARGIN_X:0,WALLPAPER_EDITOR_MARGIN_Y:0});
  const text=readFileSync(new URL('../../'+source,import.meta.url),'utf8');
  vm.runInContext(text.split(/\r?\n/).filter(line=>/^function (wallpaperDraftBaseCardHeight|layoutWallpaperDraftGroup|fitWallpaperDraftGroup|resizeWallpaperDraftGroup|applyWallpaperWidthRule|wallpaperLayoutTiles)\(/.test(line)).join('\n'),ctx);
  return ctx;
}
function group({count=1,width=240,rows=1,slots=2,compact=false,x=0,y=0}={}){
  return {id:'group',x,y,width:width*slots,height:Math.max(60,Math.ceil(((compact?46:226)+(rows-1)*46)*width/240)),cardWidth:width,rowsPerColumn:rows,slotColumns:slots,layoutRows:rows,layoutColumns:slots,nextSide:'right',layer:1,
    tileIds:Array.from({length:count},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`),
    cards:Array.from({length:count},()=>({amount:33,displayKind:'donation',imageUrl:compact?null:'fixture.png'}))};
}
function assertSaveable(ctx){
  const tiles=vm.runInContext('wallpaperLayoutTiles()',ctx);
  for(const t of tiles){
    assert.ok(t.x>=0&&t.y>=0&&t.width>=80&&t.height>=60&&t.x+t.width<=1920&&t.y+t.height<=1080,JSON.stringify(t));
    assert.ok(t.columns>=1&&t.columns<=217&&t.rows>=1&&t.rows<=216);
  }
}
for(const source of sources){
  test(`${source}: resizing 13 columns to the right edge stays inside integer bounds`,()=>{
    const ctx=context(source);ctx.g=group({count:12,width:147,slots:13});ctx.state.wallpaperDraft=[ctx.g];
    ctx.p={direction:'e',resizeMode:'card',start:{...ctx.g,rows:1,baseCardHeight:226}};
    vm.runInContext('resizeWallpaperDraftGroup(g,p,100,0)',ctx);assertSaveable(ctx);
  });
  test(`${source}: dense existing stack can resize below 80px without overflowing`,()=>{
    const ctx=context(source);ctx.g=group({count:80,width:60,rows:80});ctx.state.wallpaperDraft=[ctx.g];
    ctx.p={direction:'e',resizeMode:'card',start:{...ctx.g,rows:80,baseCardHeight:226}};
    vm.runInContext('resizeWallpaperDraftGroup(g,p,50,0)',ctx);assertSaveable(ctx);
    assert.equal(ctx.g.cards.length,80);assert.equal(ctx.g.layoutRows,80);
  });
  test(`${source}: compact bottom-edge group cannot block saving another group`,()=>{
    const ctx=context(source);ctx.g=group({compact:true,x:1440,y:1034});ctx.g.height=46;
    ctx.state.wallpaperDraft=[ctx.g,group({x:300,y:300})];
    vm.runInContext('state.wallpaperDraft.forEach(fitWallpaperDraftGroup)',ctx);assertSaveable(ctx);
    assert.equal(ctx.g.y+ctx.g.height,1080);
  });
  test(`${source}: width rule keeps compact group inside the bottom edge`,()=>{
    const ctx=context(source);ctx.g=group({compact:true,y:1020});ctx.state.wallpaperDraft=[ctx.g];
    vm.runInContext('applyWallpaperWidthRule({min:33,max:33,width:240})',ctx);assertSaveable(ctx);
  });
  test(`${source}: all eight handles preserve bounds and members in both resize modes`,()=>{
    const ctx=context(source);
    for(const compact of [false,true])for(const count of [1,12,80,216])for(const rows of [1,12,80,216]){
      ctx.g=group({count,rows,slots:Math.ceil(count/rows)+1,width:240,compact,x:1910,y:1070});
      vm.runInContext('fitWallpaperDraftGroup(g)',ctx);
      const baseline=structuredClone(ctx.g);
      for(const direction of ['n','ne','e','se','s','sw','w','nw'])for(const resizeMode of ['card','area'])for(const delta of [-3000,-1,1,3000]){
        ctx.g=structuredClone(baseline);ctx.state.wallpaperDraft=[ctx.g];
        ctx.p={direction,resizeMode,start:{...ctx.g,rows:ctx.g.layoutRows,baseCardHeight:compact?46:226}};ctx.delta=delta;
        vm.runInContext('resizeWallpaperDraftGroup(g,p,delta,delta)',ctx);assertSaveable(ctx);
        assert.equal(ctx.g.cards.length,count);assert.deepEqual([...ctx.g.tileIds],[...baseline.tileIds]);
      }
    }
  });
}
