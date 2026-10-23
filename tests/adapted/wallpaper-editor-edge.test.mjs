import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../../apps/windows-agent/Ui/wallpaper_editor.html',import.meta.url),'utf8');
function context(){
  const ctx=vm.createContext({state:{wallpaperDraft:[]},WALLPAPER_SNAP_SCREEN_PX:7,WALLPAPER_GROUP_SNAP_SCREEN_PX:7,WALLPAPER_GROUP_CROSS_SNAP_SCREEN_PX:18,WALLPAPER_VERTICAL_NEIGHBOR_SCREEN_PX:96,WALLPAPER_VERTICAL_LOCK_RELEASE_SCREEN_PX:28,WALLPAPER_META_HEIGHT_RATIO:.2035,wallpaperVisibleImageBounds:()=>null,renderWallpaperSnapGuide:()=>{}});
  vm.runInContext(html.split(/\r?\n/).filter(line=>/^function (wallpaperDonationBoxBounds|snapWallpaperMove)\(/.test(line)).join('\n'),ctx);
  return ctx;
}
for(const scale of [.4,.58,1])for(const side of ['left','right']){
  test(`${side} canvas edge releases an adjacent group lock at scale ${scale}`,()=>{
    const ctx=context();
    ctx.group={id:'moving',x:side==='right'?1440:0,y:600,width:480,height:400,cards:[{x:0,y:0,width:480,height:400}]};
    ctx.pointer={verticalSnap:{targetX:side==='right'?1900:20,movingEdge:side,sourceGroupId:'neighbor'}};
    ctx.state.wallpaperDraft=[{id:'neighbor',x:side==='right'?1420:20,y:600,width:480,height:400,cards:[]}];
    ctx.scale=scale;
    vm.runInContext('snapWallpaperMove(group,scale,group.id,pointer)',ctx);
    assert.equal(ctx.group.x,side==='right'?1440:0);
    assert.equal(ctx.pointer.verticalSnap,null);
  });
}
test('group alignment remains locked away from canvas edges',()=>{
  const ctx=context();
  ctx.group={id:'moving',x:910,y:400,width:480,height:400,cards:[]};
  ctx.pointer={verticalSnap:{targetX:1380,movingEdge:'right'}};
  vm.runInContext('snapWallpaperMove(group,.58,group.id,pointer)',ctx);
  assert.equal(ctx.group.x,900);
  assert.equal(ctx.pointer.verticalSnap.targetX,1380);
});
