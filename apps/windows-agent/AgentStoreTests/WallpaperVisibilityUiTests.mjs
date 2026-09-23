import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../Ui/wallpaper_editor.html',import.meta.url),'utf8');
const saving=source.match(/^async function saveWallpaperVisibleKeys\(.*$/m)?.[0];
const polling=source.match(/^async function refreshWallpaperLive\(.*$/m)?.[0];
const calls=[],statuses=[];
const context={state:{wallpaper:{revision:9,visibility:{visibleKeys:['donation:1','donation:33']}},wallpaperEditing:false},localWallpaperEditor:true,
  request:async(operation,options)=>{calls.push({operation,options});if(options)throw Object.assign(Error('conflict'),{status:409});return {revision:10,visibility:{visibleKeys:['donation:1','donation:33']}}},
  renderWallpaperCatalog(){},renderWallpaper(){},initializeWallpaperEditor(){},status(...args){statuses.push(args)},
  rebaseWallpaperDraft(){},document:{visibilityState:'visible'},wallpaperRefreshInFlight:false};
vm.createContext(context);vm.runInContext(saving+'\n'+polling,context);
assert.equal(await context.saveWallpaperVisibleKeys(['donation:33']),false);
assert.equal(calls[0].operation,'wallpaper-control');assert.deepEqual(JSON.parse(calls[0].options.body).visibleKeys,['donation:33']);
assert.equal(calls[1].operation,'wallpaper-refresh');assert.equal(context.state.wallpaper.revision,10);assert.equal(context.state.wallpaperVisibilitySaving,false);
const before=calls.length;context.state.wallpaperVisibilitySaving=true;await context.refreshWallpaperLive();assert.equal(calls.length,before);
context.state.wallpaperVisibilitySaving=false;
let finish;
context.request=()=>new Promise(resolve=>{finish=resolve});
const poll=context.refreshWallpaperLive();context.state.wallpaperVisibilitySaving=true;finish({revision:99});await poll;
assert.equal(context.state.wallpaper.revision,10);
console.log('PASS: one-balloon request preserves other amounts, 409 refreshes server state, both polling race boundaries respect visibility save');
