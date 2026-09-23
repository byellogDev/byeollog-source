import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out='output/chat-export-fix-20260920/obs';await mkdir(out,{recursive:true});
const config=JSON.parse(await readFile('../.tmp/obs-chat-test/config/obs-studio/plugin_config/obs-websocket/config.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true}),editor=await browser.newPage();
await editor.goto('http://127.0.0.1:4319/chat-studio');await editor.waitForFunction(()=>window.__CHAT_THEME_READY__);
const base=await editor.evaluate(()=>theme());
const cssProvider=(await readFile('output/chat-export-audit-20260920/weflab-0.css','utf8')).replace(/url\([^)]*\)/g,'none');
const chat='<div class="chat_box chat afreeca"><div class="inner_box"><p class="name"><span class="icon_platform">P</span><span class="icon_badge afreeca streamer">★</span><span class="nick">테스트 닉네임</span></p><p class="text">한글 채팅 ABC 123 출력 검증</p></div></div>';
const event='<div class="chat_box afreeca donation"><div class="inner_box"><div class="donation_box etc"><div class="text_box"><p class="nick">후원자 닉네임</p><p class="val">별풍선 <b>1,234,567,890</b>개</p></div></div></div></div>';
const generic='<div class="chat-stage"><div class="chat-list"><div class="chat-message"><span class="platform">P</span><span class="badge">★</span><span class="nickname">테스트 닉네임</span><span class="text">한글 채팅 ABC 123 출력 검증</span></div><div class="chat-message donation event-card">별풍선 100개</div></div></div>';
const inputName='Chat CSS Fixture '+Date.now();
const pending=new Map(),results=[];let current;
const server=http.createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const c of req)body+=c;const r=JSON.parse(body);pending.get(r.id)?.(r);res.end('ok');return}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(current.html);
});await new Promise(r=>server.listen(4320,'127.0.0.1',r));
const ws=new WebSocket('ws://127.0.0.1:4459');const requests=new Map();let seq=0;
const identified=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OBS connection timeout')),15000);ws.addEventListener('error',()=>reject(Error('OBS connection failed')));ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.op===0){const a=m.d.authentication;const secret=createHash('sha256').update(config.server_password+a.salt).digest('base64');const authentication=createHash('sha256').update(secret+a.challenge).digest('base64');ws.send(JSON.stringify({op:1,d:{rpcVersion:1,authentication,eventSubscriptions:0}}))}if(m.op===2){clearTimeout(timer);resolve()}if(m.op===7){const h=requests.get(m.d.requestId);if(h){requests.delete(m.d.requestId);m.d.requestStatus.result?h.resolve(m.d.responseData):h.reject(Error(m.d.requestType+': '+m.d.requestStatus.comment))}}})});
async function request(requestType,requestData={}){const requestId=String(++seq);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OBS request timeout '+requestType)),15000);requests.set(requestId,{resolve:d=>{clearTimeout(timer);resolve(d)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({op:6,d:{requestType,requestId,requestData}}))})}
try{
 await identified;const version=await request('GetVersion');
 const inputs=await request('GetInputList');assert.equal(inputs.inputs.filter(x=>!x.inputName.startsWith('Chat CSS Fixture')).length,0,'Isolated scene must contain no capture inputs');
 for(const x of inputs.inputs)await request('RemoveInput',{inputName:x.inputName});
 let created=false;
 assert.equal((await request('GetStreamStatus')).outputActive,false);assert.equal((await request('GetRecordStatus')).outputActive,false);
 const scenes=await request('GetSceneList'),sceneName=scenes.currentProgramSceneName;
 for(const adapter of ['generic','weflab'])for(const mode of ['configured','hidden-name','inline','narrow']){
  const id=adapter+'-'+mode,t=structuredClone(base);t.bubble={...t.bubble,background:'#123456',textColor:'#aabbcc',borderWidth:3};t.typography={fontSize:24,lineHeight:2,fontWeight:700,letterSpacing:1};t.nickname={visible:mode!=='hidden-name',color:'#abcdef',size:18,gap:12,break:mode!=='inline'};t.visibility={platform:true,badge:true};t.canvas.width=mode==='narrow'?240:640;t.donation.width=mode==='narrow'?600:280;t.eventCards={...t.eventCards,useBubbleStyle:false,textColor:'#ddeeff',background:'#234567'};
  const css=await editor.evaluate(({t,adapter})=>generateCss(t,adapter),{t,adapter});
  const code=`(${function(id,a,t){
   const q=s=>document.querySelector(s),style=e=>getComputedStyle(e),checks=[];
   function check(name,actual,expected){checks.push({name,actual,expected,pass:actual===expected})}
   const bubble=q(a==='weflab'?'.chat_box.chat':'.chat-message'),text=bubble.querySelector('.text'),nick=bubble.querySelector(a==='weflab'?'.nick':'.nickname'),badge=bubble.querySelector(a==='weflab'?'.icon_badge':'.badge');
   check('text color',style(text).color,'rgb(170, 187, 204)');check('font size',style(text).fontSize,'24px');check('font weight',style(text).fontWeight,'700');check('line height',style(text).lineHeight,'48px');check('nickname visibility',!!nick.getClientRects().length,t.nickname.visible);check('badge visibility',!!badge.getClientRects().length,true);check('shadow',style(bubble).boxShadow!=='none',true);
   const donation=q(a==='weflab'?'.chat_box.donation':'.chat-message.donation');check('card width contained',donation.getBoundingClientRect().width<=t.canvas.width,true);
   if(a==='weflab'){const val=q('.text_box .val'),number=val.querySelector('b');check('event name container alignment',style(q('.text_box')).textAlign,t.donation.center?'center':'left');check('event text color',style(val).color,'rgb(221, 238, 255)');check('number color',style(number).color,'rgb(221, 238, 255)');check('event text alignment',style(val).textAlign,t.donation.center?'center':'left');check('number no wrap',style(number).whiteSpace,'nowrap');check('number contained',number.getBoundingClientRect().width<=q('.text_box').getBoundingClientRect().width,true);check('provider root position',style(q('#page_wrap')).position,'absolute')}
   fetch('/result',{method:'POST',body:JSON.stringify({id,checks,userAgent:navigator.userAgent})});
  }.toString()})(${JSON.stringify(id)},${JSON.stringify(adapter)},${JSON.stringify(t)});`;
  const html=`<!doctype html><meta charset="utf-8"><style>${adapter==='weflab'?cssProvider:''}</style><style>html,body{margin:0;background:transparent;font-family:Arial}#page_wrap{width:${t.canvas.width}px;height:720px;font-size:10px}.page_area.chat,.chat_wrap,.chat_area{width:100%;height:100%}</style>${adapter==='weflab'?'<div id="page_wrap" class="chat init"><div class="page_area chat item_chat_theme_normal item_chat_align_normal item_chat_name item_chat_platform item_chat_badgeafreecastreamer"><div class="chat_wrap"><div class="chat_area"><div class="chat_list">'+chat+event+'</div></div></div></div></div>':generic}<script>setTimeout(()=>{${code}},1200)</script>`;
  current={html};await writeFile(out+'/'+id+'.html',html);await writeFile(out+'/'+id+'.css',css);
  const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OBS browser output timeout '+id)),15000);pending.set(id,r=>{clearTimeout(timer);resolve(r)})});
  if(!created){await request('CreateInput',{sceneName,inputName,inputKind:'browser_source',inputSettings:{url:'http://127.0.0.1:4320/'+id,width:1000,height:800,css,reroute_audio:true},sceneItemEnabled:true});created=true;}
  else await request('SetInputSettings',{inputName,inputSettings:{url:'http://127.0.0.1:4320/'+id,width:1000,height:800,css,reroute_audio:true},overlay:false});
  const r=await result;results.push(r);await new Promise(resolve=>setTimeout(resolve,700));const shot=await request('GetSourceScreenshot',{sourceName:inputName,imageFormat:'png',imageWidth:1000,imageHeight:800});await writeFile(out+'/'+id+'.png',Buffer.from(shot.imageData.split(',')[1],'base64'));
 }
 const failures=results.flatMap(r=>r.checks.filter(c=>!c.pass).map(c=>({id:r.id,...c})));
 await writeFile(out+'/verification.json',JSON.stringify({version,results,failures,scope:'Real isolated OBS browser_source with exported CSS and public Weflab stylesheet/observed markup. No live chat server, stream, recording, user scenes or credentials.'},null,2));
 console.log(JSON.stringify({obs:version.obsVersion,scenarios:results.length,checks:results.reduce((n,r)=>n+r.checks.length,0),failures}));if(failures.length)process.exitCode=1;
 await request('RemoveInput',{inputName});
}finally{ws.close();server.close();await browser.close()}
