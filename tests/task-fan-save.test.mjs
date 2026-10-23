import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../apps/web/lib/admin-source.html',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function saveItem(){'),source.indexOf('const completionWrites=new Set();'));
function setup({writeFails=false,readFails=false}={}){
 const els={},messages=[],writes=[];let fanReadFails=readFails;
 const $=id=>els[id]??={value:'',disabled:false,textContent:'',files:[],classList:{add(){},remove(){}},querySelectorAll:()=>[]};
 for(const [id,value] of Object.entries({fanSoopId:'new_donor',fan:'Fixture',type:'Test',event:'October',totalQty:'1'}))$(id).value=value;
 $('saveItemBtn').textContent='저장';
 const ctx=vm.createContext({$,tasks:[],fanProfiles:{},editTaskSnapshot:null,newTaskDraft:{kept:true},requireLogin:()=>true,fanProfilesMatchingNickname:()=>[],uniqueFanProfileByNickname:()=>null,alert:m=>messages.push(m),confirm:()=>true,URLSearchParams,console:{error(){}},canonicalStationUrl:id=>'https://www.sooplive.com/station/'+id,render:async()=>{},updateStats(){},getLocalFiles:async()=>[],dedupeLocalFiles:x=>x,
 api:async(path,opt)=>{if(!opt)return [ctx.tasks[0]];writes.push(opt.method);if(writeFails)throw Error('DB rejected');return [{...JSON.parse(opt.body),id:'test-task'}]},
 apiTable:async(table,path,opt)=>{assert.equal(table,'bangsel_fans');if(opt?.method==='POST')throw Error('duplicate fan');if(fanReadFails){fanReadFails=false;throw Error('temporary read failure');}return [{soop_id:'new_donor',alias:'Fixture'}]},updateFanProfileAndTasks:async()=>{}});
 vm.runInContext(code,ctx);return {ctx,els,messages,writes};
}
test('new fan saved by DB is read back, not inserted a second time',async()=>{const h=setup();await h.ctx.saveItem();assert.equal(h.messages.at(-1),'새 업보를 저장했습니다.');assert.equal(h.ctx.fanProfiles.new_donor.alias,'Fixture');assert.deepEqual(h.writes,['POST']);assert.equal(h.els.saveItemBtn.disabled,false);});
test('DB failure keeps draft and input; save button is released',async()=>{const h=setup({writeFails:true});await h.ctx.saveItem();assert.match(h.messages[0],/저장하지 못했습니다/);assert.equal(h.ctx.newTaskDraft.kept,true);assert.equal(h.els.fan.value,'Fixture');assert.equal(h.els.saveItemBtn.disabled,false);assert.equal(h.ctx.tasks.length,0);});
test('post-commit read failure reports saved task and retry updates it',async()=>{const h=setup({readFails:true});await h.ctx.saveItem();assert.match(h.messages[0],/업보는 서버에 저장됐습니다/);assert.equal(h.els.editId.value,'test-task');await h.ctx.saveItem();assert.deepEqual(h.writes,['POST','PATCH']);assert.equal(h.messages.at(-1),'수정 내용을 저장했습니다.');});
