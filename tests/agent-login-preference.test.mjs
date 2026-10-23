import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('login UI sends ID storage and automatic login independently and preserves choices while busy',()=>{
  const html=fs.readFileSync(new URL('../apps/windows-agent/Ui/byeollog_ui.html',import.meta.url),'utf8');
  const nodes=new Map(),sent=[];
  const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'',checked:false,style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},focus(){}});return nodes.get(s)};
  const window={chrome:{webview:{postMessage:m=>sent.push(m)}}};
  const context=vm.createContext({window,document:{querySelector:node,addEventListener(){}},location:{search:'?mode=login'},URLSearchParams,innerWidth:420,innerHeight:560,addEventListener(){},setTimeout,clearTimeout});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  window.byeollog.setLoginState({rememberedId:'fixture@example.com',autoLogin:false});
  assert.equal(node('#rememberId').checked,true);assert.equal(node('#autoLogin').checked,false);
  for(const remember of [false,true])for(const autoLogin of [false,true]){
    node('#rememberId').checked=remember;node('#autoLogin').checked=autoLogin;
    window.byeollog.setLoginState({busy:true});
    assert.equal(node('#autoLogin').disabled,true);assert.equal(node('#autoLogin').checked,autoLogin);
    window.byeollog.setLoginState({busy:false});node('#loginSubmit').onclick();
    assert.equal(sent.at(-1).payload.remember,remember);assert.equal(sent.at(-1).payload.autoLogin,autoLogin);
  }
});

test('main UI distinguishes lost login and initialization failure from a temporary reconnect',()=>{
  const html=fs.readFileSync(new URL('../apps/windows-agent/Ui/byeollog_ui.html',import.meta.url),'utf8');
  const nodes=new Map();
  const node=s=>{if(!nodes.has(s))nodes.set(s,{style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},focus(){}});return nodes.get(s)};
  const window={};
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],vm.createContext({window,document:{querySelector:node,addEventListener(){}},location:{search:''},URLSearchParams,innerWidth:420,innerHeight:560,addEventListener(){},setTimeout,clearTimeout}));
  for(const [state,title] of [['attention','다시 로그인해주세요'],['failed','프로그램 시작 확인 필요'],['recovering','서버 재연결 중']]){
    window.byeollog.setMainState({serverConnected:false,developmentRecoveryState:state});
    assert.equal(node('#statusTitle').textContent,title);
    if(state==='attention')assert.match(node('#statusMessage').textContent,/다시 실행하여 로그인/);
  }
  window.byeollog.setMainState({serverConnected:true,developmentRecoveryState:'ready'});
  assert.equal(node('#statusTitle').textContent,'서버 연결됨');
});
