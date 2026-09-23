import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=process.env.CHAT_TEXT_OUT||'output/chat-text-position-20260920';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<1,`${label}: ${a} vs ${b}`);
const rect=async(s)=>page.locator(s).first().boundingBox();
const theme=()=>page.evaluate(()=>window.ByeollogChatStudio.savedTheme());
const setPadding=async(p)=>page.evaluate(p=>{for(const[k,v]of Object.entries(p))document.getElementById('pad'+k[0].toUpperCase()+k.slice(1)).value=v;refresh()},p);
try{
 await page.goto((process.env.CHAT_STUDIO_URL||'http://127.0.0.1:4319')+'/chat-studio');await page.waitForFunction(()=>window.ByeollogChatStudio);
 await page.locator('[data-adapter-choice="weflab"]').click();await page.locator('#guideDismiss').click();
 await page.evaluate(()=>{document.getElementById('align').value='left';document.getElementById('frameWidth').value=720;document.getElementById('frameHeight').value=780;document.getElementById('showNick').checked=false;document.getElementById('showPlatform').checked=false;refresh()});
 // Real provider SVG, independently toggled when nickname/platform are hidden.
 const provider=await readFile('output/chat-export-audit-20260920/weflab-0.css','utf8'),badge=provider.match(/\.icon_badge\.afreeca\.manager\{background:url\("([^"]+)"\)/)[1];
 assert.equal(await page.locator('.sample-bubble .badge').first().getAttribute('src'),badge);
 assert.equal(await page.locator('.sample-bubble .badge:visible').count(),5);
 assert.ok(await page.locator('.badge').first().evaluate(e=>e.complete&&e.naturalWidth===14));
 await page.locator('#showBadge').uncheck();assert.equal(await page.locator('.sample-bubble .badge:visible').count(),0);
 assert.equal(await page.locator('.sample-bubble .meta:visible').count(),0);await page.locator('#showBadge').check();checks.push('original Weflab manager badge: enabled/disabled independently');
 // Alignment is visible even in fit-content bubbles with generous padding.
 await setPadding({left:56,right:56,top:50,bottom:50});
 const initial=await rect('.sample-bubble'),positions=[];
 for(const horizontal of ['left','center','right']){
  await page.locator(`[data-text-align="${horizontal}"]`).click();const b=await rect('.sample-bubble'),text=await rect('.chat-text-content');close(b.width,initial.width,'horizontal width');close(b.height,initial.height,'horizontal height');positions.push(text.x-b.x);
  assert.equal(await page.locator('[data-text-align][aria-pressed="true"]').getAttribute('data-text-align'),horizontal);
 }
 assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]);checks.push('left/center/right visibly move text without resizing bubble');
 const verticalPositions=[];
 for(const vertical of ['top','center','bottom']){
  await page.locator(`[data-text-valign="${vertical}"]`).click();const b=await rect('.sample-bubble'),text=await rect('.chat-text-content');close(b.width,initial.width,'vertical width');close(b.height,initial.height,'vertical height');verticalPositions.push(text.y-b.y);
 }
 assert.ok(verticalPositions[0]<verticalPositions[1]&&verticalPositions[1]<verticalPositions[2]);checks.push('top/center/bottom visibly move text in tall bubble');
 await page.locator('[data-text-align="center"]').click();await setPadding({left:56,right:56,top:50,bottom:50});
 const b0=await rect('.sample-bubble'),t0=await rect('.chat-text-content'),p0=(await theme()).bubble.padding;
 await page.mouse.move(t0.x+t0.width/2,t0.y+t0.height/2);await page.mouse.down();await page.mouse.move(t0.x+t0.width/2+24,t0.y+t0.height/2+20,{steps:6});await page.mouse.up();
 const p1=(await theme()).bubble.padding,t1=await rect('.chat-text-content'),b1=await rect('.sample-bubble');
 assert.deepEqual(p1,{top:70,right:32,bottom:30,left:80});close(t1.x-t0.x,24,'drag x');close(t1.y-t0.y,20,'drag y');close(b1.width,b0.width,'drag width');close(b1.height,b0.height,'drag height');
 await page.locator('.chat-text-content').first().press('ArrowLeft');assert.equal((await theme()).bubble.padding.left,79);await page.locator('.chat-text-content').first().press('Shift+ArrowUp');assert.equal((await theme()).bubble.padding.top,60);checks.push('real pointer drag both axes + keyboard nudge');
 const original=(await theme()).bubble.padding,t2=await rect('.chat-text-content');await page.mouse.move(t2.x+20,t2.y+10);await page.mouse.down();await page.mouse.move(t2.x+30,t2.y+15);await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual((await theme()).bubble.padding,original);checks.push('Escape cancels in-progress drag');
 const t3=await rect('.chat-text-content');await page.mouse.move(t3.x+20,t3.y+10);await page.mouse.down();await page.mouse.move(t3.x+30,t3.y+15);await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1})));await page.mouse.up();assert.deepEqual((await theme()).bubble.padding,original);checks.push('pointer cancellation restores starting position');
 await page.evaluate(()=>{moveTextPadding(theme().bubble.padding,10000,-10000);refresh()});const limited=(await theme()).bubble.padding;assert.ok(Object.values(limited).every(n=>n>=0&&n<=120));assert.equal(limited.left+limited.right,112);assert.equal(limited.top+limited.bottom,100);checks.push('drag boundaries preserve padding totals');
 // Save, reset and import the exact design file through the user controls.
 await page.locator('[data-text-align="right"]').click();await page.locator('[data-text-valign="bottom"]').click();const savedTheme=await theme();
 const pending=page.waitForEvent('download');await page.locator('#saveDesignTop').click();const download=await pending;await download.saveAs(out+'/saved.json');
 await page.locator('[data-text-align="left"]').click();await page.locator('[data-text-valign="top"]').click();await page.locator('#designFile').setInputFiles(out+'/saved.json');await page.waitForFunction(()=>document.getElementById('textAlign').value==='right');assert.deepEqual((await theme()).bubble.padding,savedTheme.bubble.padding);
 const legacy=structuredClone(savedTheme);delete legacy.typography.textAlign;const validated=await page.evaluate(x=>ByeollogChatStudio.validateDesign(x),legacy);assert.equal(validated.values.textAlign,'left');checks.push('download/import retains position, legacy file defaults safely');
 // Render exported CSS with the actual Weflab stylesheet, including multi-line
 // chat, emote, and event text. Compare all nine alignments and exact paddings.
 const fixture=await context.newPage();await fixture.route('**/*',r=>r.abort());
 for(const adapter of ['generic','weflab'])for(const horizontal of ['left','center','right'])for(const vertical of ['top','center','bottom']){
  await page.locator(`[data-text-align="${horizontal}"]`).click();await page.locator(`[data-text-valign="${vertical}"]`).click();
  const t=await theme(),css=await page.evaluate(({t,adapter})=>generateCss(t,adapter),{t,adapter});
  const body=adapter==='weflab'?`<div id="page_wrap" class="chat init"><div class="page_area chat platform_1 item_chat_theme_normal item_chat_align_normal item_chat_direction_left item_chat_name"><div class="chat_wrap"><div class="chat_area"><div class="chat_list"><div class="chat_box afreeca chat"><div class="inner_box"><p class="name"><span class="icon_badge afreeca manager"></span><span class="nick">닉네임</span></p><p class="text">여러 줄 채팅 확인입니다<br>짧은 두 번째 줄</p></div></div><div class="chat_box afreeca donation"><div class="inner_box"><div class="donation_box"><div class="text_box"><p class="val"><b>별풍선 100개</b></p></div></div></div></div></div></div></div></div></div>`:`<div class="chat-stage"><div class="chat-list"><div class="chat-message"><span class="nickname">닉네임</span><span class="text">여러 줄 채팅 확인입니다<br>짧은 두 번째 줄</span></div><div class="chat-message donation event-card"><div class="event-service-surface">별풍선 100개</div></div></div></div>`;
  await fixture.setContent(`<style>${adapter==='weflab'?provider:''}</style><style>${css}</style><style>body{margin:0}#page_wrap{width:600px;height:750px;font-size:10px}.page_area.chat,.chat_wrap,.chat_area{height:100%;width:100%}*,*::before,*::after{animation:none!important;transition:none!important}</style>${body}`);await fixture.evaluate(()=>document.fonts.ready);
  const normal=adapter==='weflab'?'.chat_box.chat .inner_box':'.chat-message:not(.donation)',event=adapter==='weflab'?'.chat_box.donation .inner_box':'.chat-message.donation';
  for(const selector of [normal,event]){const actual=await fixture.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return {align:s.textAlign,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft]}});assert.deepEqual(actual,{align:horizontal,padding:[t.bubble.padding.top,t.bubble.padding.right,t.bubble.padding.bottom,t.bubble.padding.left].map(n=>n+'px')},adapter+' '+selector)}
  if(horizontal==='center'&&vertical==='center')await fixture.screenshot({path:out+'/'+adapter+'-center.png'});
 }
 checks.push('18 exported alignment combinations: Weflab public styles and generic HTML');
 await page.locator('[data-text-align="center"]').click();await page.locator('[data-text-valign="center"]').click();
 await page.screenshot({path:out+'/editor.png'});await page.locator('#previewStage').screenshot({path:out+'/preview.png'});
 await page.setViewportSize({width:390,height:844});await page.locator('#showEditor').click();await page.locator('[data-text-align="left"]').scrollIntoViewIfNeeded();assert.ok(await page.locator('[data-text-align="left"]').isVisible());await page.locator('[data-text-align="left"]').click();await page.locator('[data-text-valign="bottom"]').click();await page.screenshot({path:out+'/mobile-controls.png'});checks.push('mobile positioning controls accessible');
 assert.deepEqual(errors,[]);await writeFile(out+'/text-position.json',JSON.stringify({pass:true,checks,errors},null,2));console.log(JSON.stringify({pass:true,checks,errors}));
}finally{await browser.close()}
