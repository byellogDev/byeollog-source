import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url),sharp=require('sharp');
const {chromium}=require('C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=process.env.CHAT_AUDIT_OUT||'output/chat-export-fix-20260920';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1000,height:800}});
const editor=await context.newPage();await editor.goto('http://127.0.0.1:4319/chat-studio');await editor.waitForFunction(()=>window.__CHAT_THEME_READY__);
const base=await editor.evaluate(()=>theme());
const page=await context.newPage();await page.route('**/*',route=>route.abort());
const publicCss=await readFile('output/chat-export-audit-20260920/weflab-0.css','utf8');
const providerCss=`.page_area.chat .chat_box:not(.fixed).afreeca p.name,.page_area.chat .chat_box:not(.fixed).afreeca p.text{color:#ffffff}.page_area.chat{font-family:Arial;font-size:1.96em}`;
const providerClasses='page_area chat platform_1 item_chat_theme_normal item_chat_align_normal item_chat_direction_left item_chat_name item_chat_badgeafreecastreamer';
const chat=`<div class="chat_box afreeca chat streamer even_0 rand_0 color_0"><div class="inner_box"><p class="name"><span class="icon_platform afreeca"></span><span class="icon_badge afreeca streamer"></span><span class="nick">검증닉네임</span></p><p class="text">채팅 출력 검증 메시지</p></div></div>`;
const donation=`<div class="chat_box afreeca donation"><div class="inner_box"><div class="event-service-surface"><p class="name"><span class="nick">후원닉네임</span></p><p class="text">별풍선 <span class="count">1234567890</span>개</p></div></div></div>`;
const generic=`<div class="chat-stage"><div class="chat-list"><div class="chat-message"><span class="platform">P</span><span class="badge">B</span><span class="nickname">검증닉네임</span><span class="text">채팅 출력 검증 메시지</span></div><div class="chat-message donation event-card"><div class="event-service-surface">별풍선 <span class="count">1234567890</span>개</div></div></div></div>`;
const records=[];
const add=(id,adapter,actual,expected,pass=JSON.stringify(actual)===JSON.stringify(expected))=>records.push({id,adapter,pass,expected,actual});
const css=async(t,a)=>editor.evaluate(({t,a})=>generateCss(t,a),{t,a});
async function render(t,a){const code=await css(t,a);await page.setContent(`<!doctype html><meta charset="utf-8"><style>${a==='weflab'?publicCss+providerCss:''}</style><style>body{margin:0;font-family:Arial;background:transparent}#page_wrap{width:640px;height:720px;font-size:10px}.page_area.chat,.chat_wrap,.chat_area{height:100%;width:100%}</style><style id="exported">${code}</style>${a==='weflab'?`<div id="page_wrap" class="chat init"><div class="${providerClasses}"><div class="chat_wrap"><div class="chat_area"><div class="chat_list">${chat}${donation}</div></div></div></div></div>`:generic}`);return code}
const sel=a=>a==='weflab'?'.chat_box.chat':'.chat-message:not(.donation)';
const val=async(s,p,ps=null)=>page.locator(s).first().evaluate((e,{p,ps})=>getComputedStyle(e,ps).getPropertyValue(p),{p,ps});
const rgb=h=>`rgb(${parseInt(h.slice(1,3),16)}, ${parseInt(h.slice(3,5),16)}, ${parseInt(h.slice(5,7),16)})`;
try{
 for(const a of ['generic','weflab']){
  const t=structuredClone(base);Object.assign(t.bubble,{background:'#123456',textColor:'#aabbcc',borderColor:'#654321',borderWidth:3,radius:{tl:7,tr:11,br:15,bl:19},padding:{top:10,right:12,bottom:14,left:16}});Object.assign(t.typography,{fontSize:24,lineHeight:2,fontWeight:700,letterSpacing:2});Object.assign(t.nickname,{visible:true,color:'#abcdef',size:18,gap:13,break:true});t.visibility={platform:true,badge:true};t.pattern.preset='none';t.layout.gap=25;t.tail={...t.tail,enabled:true,shape:'triangle',alignMode:'left',edgeOffset:30,width:24,height:17,yOffset:6,background:'#224466',borderWidth:0};t.eventCards={useBubbleStyle:false,stripServiceSurface:true,background:'#112233',textColor:'#ddeeff',borderColor:'#445566',borderWidth:4,radius:21};t.donation={width:280,center:true};
  await render(t,a);const s=sel(a),inner=a==='weflab'?s+' .inner_box':s,txt=s+' .text',nick=s+(a==='weflab'?' .nick':' .nickname'),ev=a==='weflab'?'.chat_box.donation':'.chat-message.donation';
  if(!(await page.locator(s).isVisible()))throw Error('Fixture chat is not visible');
  await page.screenshot({path:out+`/${a}-configured.png`});
  for(const [id,selector,prop,expected] of [['bubble-bg',s,'background-color',rgb(t.bubble.background)],['text-color',txt,'color',rgb(t.bubble.textColor)],['border-color',s,'border-top-color',rgb(t.bubble.borderColor)],['border-width',s,'border-top-width','3px'],['radius',s,'border-radius','7px 11px 15px 19px'],['padding',inner,'padding','10px 12px 14px 16px'],['font-size',txt,'font-size','24px'],['line-height',txt,'line-height','48px'],['font-weight',txt,'font-weight','700'],['letter-spacing',txt,'letter-spacing','2px'],['nickname-color',nick,'color',rgb(t.nickname.color)],['nickname-size',nick,'font-size','18px'],['event-bg',ev,'background-color',rgb(t.eventCards.background)],['event-border',ev,'border-top-width','4px'],['event-radius',ev,'border-radius','21px'],['event-center',ev,'text-align','center']])add(id,a,await val(selector,prop),expected);
  add('event-text-color',a,await val(a==='weflab'?ev+' .text':ev,'color'),rgb(t.eventCards.textColor));
  add('tail-size',a,[await val(s,'width','::after'),await val(s,'height','::after')],['24px','17px']);add('tail-color',a,await val(s,'background-color','::after'),rgb(t.tail.background));
  for(const preset of ['none','dots','grid','diagonal','cross','checker','waves','sparkle']){t.pattern={preset,color:'#aa5588',opacity:.4,size:26};await render(t,a);add('pattern-'+preset,a,(await val(s,'background-image'))!=='none',preset!=='none')}
  for(const align of ['left','right']){t.layout.alignment=align;await render(t,a);const aligned=await page.locator(s).evaluate((e,align)=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return align==='left'?Math.abs(r.left-p.left)<8:Math.abs(r.right-p.right)<8},align);add('alignment-'+align,a,aligned,true)}
  t.nickname.visible=false;t.visibility={platform:true,badge:true};await render(t,a);
  add('nickname-hidden',a,await page.locator(nick).isVisible(),false);add('icons-retained-when-nickname-hidden',a,await page.locator(s+(a==='weflab'?' .icon_badge':' .badge')).isVisible(),true);
  t.nickname.visible=true;t.visibility={platform:false,badge:false};await render(t,a);add('icons-hidden',a,[await page.locator(s+(a==='weflab'?' .icon_platform':' .platform')).isVisible(),await page.locator(s+(a==='weflab'?' .icon_badge':' .badge')).isVisible()],[false,false]);
  t.visibility={platform:true,badge:true};t.nickname.break=true;await render(t,a);const br1=await page.locator(nick).boundingBox(),tx1=await page.locator(txt).boundingBox();add('nickname-break-line',a,tx1.y>=br1.y+br1.height-1,true);records.at(-1).rects={nickname:br1,text:tx1};
  t.nickname.break=false;await render(t,a);const br2=await page.locator(nick).boundingBox(),tx2=await page.locator(txt).boundingBox();add('nickname-inline-line',a,tx2.y<br2.y+br2.height,true);records.at(-1).rects={nickname:br2,text:tx2};
  t.nickname.break=true;t.nickname.gap=0;await render(t,a);const gap0=await page.locator(txt).boundingBox(),nick0=await page.locator(nick).boundingBox();t.nickname.gap=30;await render(t,a);const gap30=await page.locator(txt).boundingBox(),nick30=await page.locator(nick).boundingBox();add('nickname-gap-visible',a,Math.abs((gap30.y-nick30.y-nick30.height)-(gap0.y-nick0.y-nick0.height))>20,true);
  const before=await css(t,a);for(const [key,value] of [['x',199],['y',177],['width',777],['height',555]]){const x=structuredClone(t);x.canvas[key]=value;add('canvas-'+key+'-in-output',a,(await css(x,a))!==before,a==='generic'&&['width','height'].includes(key))}
  await render(base,a);await page.screenshot({path:out+`/${a}-default.png`});
  const shadow=await val(sel(a),'box-shadow');add('preview-shadow-exported',a,shadow!=='none',true);
  const narrow=structuredClone(base);narrow.canvas.width=240;narrow.donation.width=600;await render(narrow,a);await page.setViewportSize({width:320,height:800});if(a==='weflab')await page.addStyleTag({content:'#page_wrap{width:240px!important}'});add('narrow-donation-contained',a,await page.locator(ev).evaluate(e=>e.getBoundingClientRect().width<=240),true);await page.screenshot({path:out+`/${a}-narrow.png`});await page.setViewportSize({width:1000,height:800});
 }
 // Compare actual raster position with the anchor point the editor promises.
 const red='data:image/png;base64,'+(await sharp({create:{width:20,height:20,channels:4,background:'#ff0000'}}).png().toBuffer()).toString('base64');
 const blue='data:image/png;base64,'+(await sharp({create:{width:20,height:20,channels:4,background:'#0000ff'}}).png().toBuffer()).toString('base64');
 for(const a of ['generic','weflab'])for(const count of [1,2])for(const target of ['left','center','right']){
  const t=structuredClone(base);t.bubble.borderWidth=0;t.bubble.background='#ffffff';t.pattern.preset='none';t.tail.enabled=false;
  const layer={id:'audit',dataUrl:red,name:'red',width:20,aspectRatio:1,scope:'bubble',visible:true,positionMode:'smart',xTarget:target,xSelf:target,yTarget:'center',ySelf:'center',xOffset:10,yOffset:0};
  t.decorations=[layer,...(count===2?[{...layer,id:'audit2',dataUrl:blue,xTarget:'center',xSelf:'center',yOffset:40,xOffset:0}]:[])];
  const code=await css(t,a),host=a==='weflab'?'<div id="page_wrap"><div class="chat_list"><div id="host" class="chat_box chat"></div></div></div>':'<div class="chat-stage"><div class="chat-list"><div id="host" class="chat-message"></div></div></div>';
  await page.setContent(`<!doctype html><style>${code}</style><style>body{margin:0;background:#eee}:is(#page_wrap,.chat-stage) #host{position:absolute!important;left:350px!important;top:300px!important;width:300px!important;height:150px!important;max-width:none!important;margin:0!important;border:0!important;box-sizing:border-box!important}</style>${host}`);
  const shot=await page.screenshot(),{data,info}=await sharp(shot).removeAlpha().raw().toBuffer({resolveWithObject:true});let minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const i=(y*info.width+x)*3;if(data[i]>245&&data[i+1]<10&&data[i+2]<10){minX=Math.min(x,minX);minY=Math.min(y,minY);maxX=Math.max(x,maxX);maxY=Math.max(y,maxY)}}
  const expectedX=target==='left'?360:target==='center'?500:620;const actual={x:Number.isFinite(minX)?minX:null,y:Number.isFinite(minY)?minY:null,width:maxX-minX+1,height:maxY-minY+1};add(`image-${count}-${target}`,a,actual,{x:expectedX,y:365,width:20,height:20},Math.abs(actual.x-expectedX)<=1&&Math.abs(actual.y-365)<=1&&actual.width===20&&actual.height===20);
  if(!records.at(-1).pass){await writeFile(out+`/${a}-image-${count}-${target}.png`,shot);records.at(-1).debug=await page.locator('#host').evaluate(e=>{let s=getComputedStyle(e),b=getComputedStyle(e,'::before'),p=e.parentElement.parentElement;return{host:e.getBoundingClientRect().toJSON(),hostStyle:[s.display,s.opacity,s.position],before:[b.content,b.width,b.height,b.left,b.top,b.backgroundImage,b.opacity,b.display],wrap:[getComputedStyle(p).opacity,getComputedStyle(p).display],sheets:document.styleSheets.length}})}
 }
 // Cover ratio/anchor placement, vertical offsets and the one-per-screen scope.
 for(const a of ['generic','weflab'])for(const count of [1,2])for(const placement of ['ratio-0','ratio-100','anchor-bottom-right','smart-bottom','overlay-right','smart-free','smart-mixed-self']){
  const t=structuredClone(base);t.bubble.borderWidth=0;t.bubble.background='#ffffff';t.pattern.preset='none';t.tail.enabled=false;
  const layer={id:'audit',dataUrl:red,name:'red',width:20,aspectRatio:1,scope:'bubble',visible:true,positionMode:'smart',xTarget:'center',xSelf:'center',yTarget:'center',ySelf:'center',xOffset:0,yOffset:0,xRatio:50,yRatio:50};let ex=490,ey=365;
  if(placement.startsWith('ratio')){layer.positionMode='ratio';layer.xRatio=placement==='ratio-0'?0:100;ex=placement==='ratio-0'?340:640}
  if(placement==='anchor-bottom-right'){Object.assign(layer,{positionMode:'anchor',anchor:'bottom-right',offsetX:10,offsetY:10});ex=620;ey=420}
  if(placement==='smart-bottom'){Object.assign(layer,{yTarget:'bottom',ySelf:'bottom',yOffset:10});ey=420}
  if(placement==='smart-free'){Object.assign(layer,{xTarget:'free',xSelf:'right',yTarget:'free',ySelf:'bottom',xRatio:33,yRatio:67,xOffset:99,yOffset:-77});ex=429;ey=380}
  if(placement==='smart-mixed-self'){Object.assign(layer,{xTarget:'right',xSelf:'left',yTarget:'top',ySelf:'bottom',xOffset:10,yOffset:10});ex=640;ey=290}
  if(placement==='overlay-right'){Object.assign(layer,{scope:'overlay',xTarget:'right',xSelf:'right',xOffset:10});ex=620}
  t.decorations=[layer,...(count===2?[{...layer,id:'audit2',dataUrl:blue,positionMode:'smart',xTarget:'center',xSelf:'center',yTarget:'top',ySelf:'top',xOffset:0,yOffset:5}]:[])];
  const code=await css(t,a),host=placement==='overlay-right'?(a==='weflab'?'<div id="page_wrap" data-audit-host></div>':'<div class="chat-stage" data-audit-host></div>'):(a==='weflab'?'<div id="page_wrap"><div class="chat_list"><div class="chat_box chat" data-audit-host></div></div></div>':'<div class="chat-stage"><div class="chat-list"><div class="chat-message" data-audit-host></div></div></div>');
  await page.setContent(`<!doctype html><style>${code}</style><style>body{margin:0;background:#eee}</style>${host}`);
  await page.locator('[data-audit-host]').evaluate(e=>e.setAttribute('style','position:absolute!important;left:350px!important;top:300px!important;width:300px!important;height:150px!important;max-width:none!important;margin:0!important;border:0!important;padding:0!important;box-sizing:border-box!important'));
  const shot=await page.screenshot(),{data,info}=await sharp(shot).removeAlpha().raw().toBuffer({resolveWithObject:true});let x0=Infinity,y0=Infinity;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){let i=(y*info.width+x)*3;if(data[i]>245&&data[i+1]<10&&data[i+2]<10){x0=Math.min(x0,x);y0=Math.min(y0,y)}}
  add(`image-${count}-${placement}`,a,{x:Number.isFinite(x0)?x0:null,y:Number.isFinite(y0)?y0:null},{x:ex,y:ey},Math.abs(x0-ex)<=1&&Math.abs(y0-ey)<=1);
 }
 // Extra cases: export must support the same image placements the editor can save.
 const importFree=await editor.evaluate(async({raw,red})=>{raw.decorations=[{dataUrl:red,width:20,scope:'bubble',positionMode:'smart',xTarget:'free',yTarget:'center',xSelf:'center',ySelf:'center',xRatio:33,yRatio:50}];try{await ByeollogChatStudio.validateDesign(raw);return{accepted:true}}catch(e){return{accepted:false,message:e.message}}},{raw:structuredClone(base),red});
 add('free-image-design-import','both',importFree.accepted,true);records.at(-1).detail=importFree;
 // Use current provider SOOP image-card markup from its public main.js.
 const eventTheme=structuredClone(base);eventTheme.eventCards={useBubbleStyle:false,stripServiceSurface:true,background:'#123456',textColor:'#ddeeff',borderColor:'#665544',borderWidth:3,radius:18};eventTheme.donation={width:200,center:true};eventTheme.nickname.visible=true;
 await render(eventTheme,'weflab');
 await page.locator('.chat_box.donation .inner_box').evaluate(e=>{e.innerHTML='<div class="donation_box etc"><div class="img_box"><div class="img"><p data-donation="1234567890" class="val">1234567890</p></div></div><div class="text_box"><p class="nick">후원자닉네임</p><p class="val">별풍선 <b>1,234,567,890</b>개</p></div></div>'});
 add('actual-soop-event-text-color','weflab',await val('.donation_box .text_box .val','color'),rgb(eventTheme.eventCards.textColor));
 add('actual-soop-event-number-no-wrap','weflab',await val('.donation_box .text_box .val b','white-space'),'nowrap');
 add('actual-soop-event-name-alignment','weflab',await val('.donation_box .text_box','text-align'),'center');
 add('actual-soop-event-number-color','weflab',await val('.donation_box .text_box .val b','color'),rgb(eventTheme.eventCards.textColor));
 add('actual-soop-event-text-align','weflab',await val('.donation_box .text_box .val','text-align'),'center');
 await page.screenshot({path:out+'/weflab-actual-event-structure.png'});
 // Exercise controls via the editor, keeping the current display gates enabled.
 const preview=await editor.evaluate(()=>{for(const [id,v]of Object.entries({showNick:true,showPlatform:true,showBadge:true,nickBreak:false,nickGap:0})){const e=document.getElementById(id);e.type==='checkbox'?e.checked=v:e.value=v}refresh();const m=document.querySelector('.sample-bubble .meta'),n=document.querySelector('.sample-bubble .nick'),b=document.querySelector('.sample-bubble .badge');return{nicknameParentDisplay:getComputedStyle(m).display,badgeElements:document.querySelectorAll('.sample-bubble .badge').length,previewShadow:getComputedStyle(document.querySelector('.sample-bubble')).boxShadow}});
 const report={createdAt:new Date().toISOString(),scope:'Generated CSS rendering against compatible generic HTML and observed Weflab chat DOM with public provider stylesheet; no saved Weflab settings changed; not OBS CEF',total:records.length,passed:records.filter(r=>r.pass).length,failed:records.filter(r=>!r.pass).length,records,preview};
 await writeFile(out+'/audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,failures:records.filter(r=>!r.pass),preview},null,2));
 if(report.failed)process.exitCode=1;
}finally{await browser.close()}
