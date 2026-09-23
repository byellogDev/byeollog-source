import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const dashboardSource=await readFile(new URL('../lib/product-dashboard-html.js',import.meta.url),'utf8');

function functionSource(name){
  const line=dashboardSource.split(/\r?\n/).find(value=>value.startsWith(`function ${name}(`));
  assert.ok(line,`missing ${name}`);
  return line;
}

function createHarness({maskRecord=true}={}){
  const appended=[];
  const canvas={
    append(node){appended.push(node)},
    querySelectorAll(){return {forEach(callback){for(const item of appended.splice(0))callback(item)}}}
  };
  const preview={querySelector(){return canvas}};
  const images=new Map();
  const groupNodes=[];
  const document={
    createElement(){return {className:'',style:{}}},
    querySelectorAll(selector){return selector==='#wallpaperPreview .wallpaper-group'?groupNodes:[]}
  };
  const state={wallpaperDraft:[],wallpaperPointer:null};
  const wallpaperImageHitMasks=new Map();
  const wallpaperImageSourcesByAssetKey=new Map();
  const context={
    console,
    document,
    state,
    wallpaperImageHitMasks,
    wallpaperImageSourcesByAssetKey,
    WALLPAPER_META_HEIGHT_RATIO:.2035,
    WALLPAPER_SNAP_SCREEN_PX:7,
    WALLPAPER_GROUP_SNAP_SCREEN_PX:7,
    WALLPAPER_GROUP_CROSS_SNAP_SCREEN_PX:18,
    WALLPAPER_VERTICAL_NEIGHBOR_SCREEN_PX:96,
    WALLPAPER_VERTICAL_LOCK_RELEASE_SCREEN_PX:28,
    $(){return preview}
  };
  const names=['wallpaperOpaqueMaskBounds','wallpaperDonationBoxBounds','wallpaperImageMaskRecord','wallpaperVisibleImageBounds','renderWallpaperSnapGuide','snapWallpaperMove'];
  vm.runInNewContext(`${names.map(functionSource).join('\n')}\nthis.api={${names.join(',')}};`,context);

  function addImage(groupId,cardId,source,record){
    const image={src:source,currentSrc:source};
    const cardNode={dataset:{tileId:cardId},querySelector(){return image}};
    const existing=groupNodes.find(node=>node.dataset.groupId===groupId);
    if(existing)existing.cards.push(cardNode);
    else groupNodes.push({dataset:{groupId},cards:[cardNode],querySelectorAll(){return this.cards}});
    images.set(cardId,image);
    wallpaperImageSourcesByAssetKey.set(cardId==='target-card'?'target':cardId,source);
    if(maskRecord)wallpaperImageHitMasks.set(source,record);
  }

  return {api:context.api,state,appended,addImage};
}

test('opaque mask bounds ignore transparent padding',()=>{
  const {api}=createHarness();
  const alpha=Uint8Array.from([
    0,0,0,0,
    0,20,20,0,
    0,20,20,0,
    0,0,0,0
  ]);
  assert.deepEqual({...api.wallpaperOpaqueMaskBounds(alpha,4,4)},{left:.25,top:.25,right:.75,bottom:.75});
});

test('visual top snap uses the painted image top and keeps legacy card snap available',()=>{
  const moving={id:'moving',x:100,y:246,width:293,height:266,cards:[{id:'moving-card',x:0,y:0,width:293,height:266,imageUrl:'moving'}]};
  const target={id:'target',x:100,y:500,width:293,height:226,cards:[{id:'target-card',x:0,y:0,width:293,height:226,imageUrl:'target'}]};
  const record={status:'ready',width:293,height:164,opaqueBounds:{left:0,top:0,right:1,bottom:1}};
  const harness=createHarness();
  harness.addImage('target','target-card','http://example.test/target.png',record);
  harness.state.wallpaperDraft=[moving,target];
  const pointer={verticalSnap:null,horizontalSnap:null};
  harness.api.snapWallpaperMove(moving,1,'moving',pointer);
  const expectedTop=500+226*(1-.2035)-164;
  assert.ok(Math.abs((moving.y+266)-expectedTop)<1e-9);
  assert.ok(Math.abs(pointer.horizontalSnap.targetY-expectedTop)<1e-9);
  assert.equal(harness.appended.some(node=>node.className==='wallpaper-image-top-snap-guide'),true);

  const legacyMoving={id:'legacy',x:100,y:409,width:293,height:266,cards:[{id:'legacy-card',x:0,y:0,width:293,height:266,imageUrl:'legacy'}]};
  const legacyHarness=createHarness({maskRecord:false});
  legacyHarness.state.wallpaperDraft=[legacyMoving,target];
  const legacyPointer={verticalSnap:null,horizontalSnap:null};
  legacyHarness.api.snapWallpaperMove(legacyMoving,1,'legacy',legacyPointer);
  const legacyTargetTop=500+226*(1-.2035);
  assert.ok(Math.abs((legacyMoving.y+266)-legacyTargetTop)<1e-9);
  assert.equal(legacyPointer.horizontalSnap,null);
});
