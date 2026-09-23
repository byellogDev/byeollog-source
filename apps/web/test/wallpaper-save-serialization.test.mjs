import assert from 'node:assert/strict';
import test from 'node:test';
import {serializeWallpaperLayoutWrite} from '../api/admin.js';

const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

test('identical concurrent wallpaper layout saves are coalesced',async()=>{
  let writes=0;
  const payload={p_expected_revision:7,p_tiles:[{id:'one',x:1,y:2}]};
  const requests=Array.from({length:100},()=>serializeWallpaperLayoutWrite(
    'workspace-coalesce',payload,async()=>{writes+=1;await wait(5);return {revision:8}}
  ));
  const results=await Promise.all(requests);
  assert.equal(writes,1);
  assert.equal(results.length,100);
  assert.deepEqual(results[0],{revision:8});
});

test('different wallpaper layout saves for one workspace never overlap',async()=>{
  let active=0;
  let maximumActive=0;
  const order=[];
  const requests=Array.from({length:25},(_,index)=>serializeWallpaperLayoutWrite(
    'workspace-serialize',
    {p_expected_revision:index,p_tiles:[{id:'one',x:index,y:0}]},
    async()=>{
      active+=1;
      maximumActive=Math.max(maximumActive,active);
      order.push(index);
      await wait(1);
      active-=1;
      return index;
    }
  ));
  assert.deepEqual(await Promise.all(requests),Array.from({length:25},(_,index)=>index));
  assert.equal(maximumActive,1);
  assert.deepEqual(order,Array.from({length:25},(_,index)=>index));
});

test('wallpaper layout saves for different workspaces remain parallel',async()=>{
  let active=0;
  let maximumActive=0;
  const write=async()=>{active+=1;maximumActive=Math.max(maximumActive,active);await wait(5);active-=1};
  await Promise.all([
    serializeWallpaperLayoutWrite('workspace-a',{x:1},write),
    serializeWallpaperLayoutWrite('workspace-b',{x:1},write)
  ]);
  assert.equal(maximumActive,2);
});
