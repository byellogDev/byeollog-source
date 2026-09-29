import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../apps/windows-agent/Ui/wallpaper-detached.js',import.meta.url),'utf8');
const ctx=vm.createContext({});vm.runInContext(source,ctx);const detached=ctx.ByeollogDetached;
const tile=(id,amount,displayKind='donation')=>({id,amount,displayKind,imageUrl:'/fixture.png'});
test('inclusive amount ranges exclude subscriptions and challenge cards',()=>{
 const view={ranges:[{min:1000,max:1000},{min:2000,max:3000}]};
 for(const amount of [1000,2000,3000])assert.equal(detached.matches(tile('a',amount),view),true);
 for(const amount of [999,1001,1999,3001])assert.equal(detached.matches(tile('a',amount),view),false);
 assert.equal(detached.matches(tile('a',1000,'subscription'),view),false);
 assert.equal(detached.matches(tile('a',1000,'challenge_success'),view),false);
});
test('same amount cards keep independent positions, newcomers start at top left',()=>{
 const tiles=[tile('a',1000),tile('b',1000),tile('c',1000)],view={ranges:[{min:1000,max:1000}],positions:{a:{x:800,y:500,width:240,height:226},b:{x:1680,y:854,width:240,height:226}}};
 const original=JSON.stringify(tiles),result=detached.cards(tiles,view);
 assert.deepEqual(Array.from(result,c=>[c.id,c.x,c.y]),[['a',800,500],['b',1680,854],['c',0,0]]);
 assert.equal(JSON.stringify(tiles),original);
});
test('baekdusan membership wins and range removal restores regular eligibility',()=>{
 const tiles=[tile('a',1000),tile('b',1000)],view={ranges:[{min:1000,max:1000}]};
 assert.deepEqual(Array.from(detached.cards(tiles,view,[],new Set(['a'])),c=>c.id),['b']);
 assert.equal(detached.cards(tiles,{ranges:[]}).length,0);
 assert.equal(tiles.filter(t=>!detached.matches(t,{ranges:[]})).length,2);
});
test('visibility and session scope use only the supplied visible snapshot',()=>{
 const view={ranges:[{min:1000,max:1000}],positions:{hidden:{x:100,y:100,width:240,height:226}}};
 assert.equal(detached.cards([],view).length,0);
 assert.deepEqual(Array.from(detached.cards([tile('visible',1000)],view),c=>c.id),['visible']);
});
test('new cards follow size rule while manually detached size remains stable',()=>{
 const result=detached.cards([tile('a',1000),tile('b',1000)],{ranges:[{min:1000,max:1000}],positions:{a:{x:0,y:0,width:240,height:226}}},[{min:1000,max:1000,width:120}]);
 assert.equal(result[0].width,240);assert.equal(result[1].width,120);assert.equal(result[1].height,113);
});
test('editor groups omit detached cards without changing source tiles',()=>{
 const html=fs.readFileSync(new URL('../../apps/windows-agent/Ui/wallpaper_editor.html',import.meta.url),'utf8');
 const context=vm.createContext({ByeollogDetached:detached});
 vm.runInContext(html.slice(html.indexOf('const localWallpaperLayout='),html.indexOf('async function request(')),context);
 const tiles=[tile('a',1000),tile('b',1000),tile('c',33)],data={localRulesLayout:true,tiles,detached:{ranges:[{min:1000,max:1000}]}};
 context.input=data;const result=vm.runInContext('applyLocalWallpaperLayout(input)',context);
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].cards[0].id,'c');assert.equal(result.tiles.length,3);
});
