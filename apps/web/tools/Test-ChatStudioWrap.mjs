import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=process.env.CHAT_WRAP_OUT||'output/chat-wrap-20260920';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1600,height:1200}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const theme=()=>page.evaluate(()=>theme());
const widths=()=>page.locator('.sample-bubble:not(.donation)').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width));
const lines=()=>page.locator('.sample-bubble:not(.donation) .msg').nth(2).evaluate(e=>{const r=document.createRange();r.selectNodeContents(e);return new Set([...r.getClientRects()].map(r=>Math.round(r.top))).size});
const handle=()=>page.locator('.bubble-wrap-guide:not(.hidden) .bubble-resize');
async function drag(dx){const r=await handle().boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2,{steps:8});await page.mouse.up()}
async function configure(values){await page.evaluate(values=>{for(const[id,v]of Object.entries(values))$(id).value=v;refresh()},values)}
try{
 await page.goto((process.env.CHAT_STUDIO_URL||'http://127.0.0.1:4319')+'/chat-studio');await page.waitForFunction(()=>window.ByeollogChatStudio);await page.locator('[data-adapter-choice="weflab"]').click();await page.locator('#guideDismiss').click();
 await configure({align:'right',fontSize:22,maxWidth:560,padLeft:14,padRight:14,padTop:12,padBottom:12});
 await page.locator('.sample-bubble .chat-text-content').nth(2).click();assert.ok(await page.locator('#bubbleEditToolbar').isVisible());assert.equal(await page.locator('.pad-handle:visible').count(),0);
 const w0=await widths(),p0=(await theme()).bubble.padding,l0=await lines();assert.equal(l0,2);
 await page.screenshot({path:out+'/before.png'});await drag(200);
 const w1=await widths(),l1=await lines();assert.equal((await theme()).layout.maxWidth,360);assert.equal(l1,3);assert.deepEqual((await theme()).bubble.padding,p0);assert.equal(w0[0],w1[0]);assert.equal(w0[1],w1[1]);assert.ok(w1[2]<w0[2]);
 await page.screenshot({path:out+'/after.png'});checks.push('right-aligned edge drag changes 2 lines to 3, reduces bubble width, preserves padding and short widths');
 await configure({maxWidth:600,padLeft:110,padRight:14});const big0=await lines(),bigw0=await widths(),bigp=(await theme()).bubble.padding;await drag(160);const big1=await lines(),bigw1=await widths();assert.ok(big1>big0);assert.ok(bigw1[2]<bigw0[2]);assert.equal(bigw1[0],bigw0[0]);assert.deepEqual((await theme()).bubble.padding,bigp);checks.push('large-left-gap example narrows bubble without freeing extra text space');
 await page.screenshot({path:out+'/large-gap.png'});
 const widthBeforeCancel=(await theme()).layout.maxWidth,r=await handle().boundingBox();await page.mouse.move(r.x+12,r.y+20);await page.mouse.down();await page.mouse.move(r.x+52,r.y+20);await page.keyboard.press('Escape');await page.mouse.up();assert.equal((await theme()).layout.maxWidth,widthBeforeCancel);
 await handle().focus();await page.keyboard.press('ArrowRight');assert.equal((await theme()).layout.maxWidth,widthBeforeCancel-1);checks.push('Escape restores width and keyboard follows anchored direction');
 await configure({align:'left',maxWidth:560,padLeft:14});await drag(-200);assert.equal((await theme()).layout.maxWidth,360);assert.equal(await lines(),3);checks.push('left alignment has mirrored inward drag behavior');
 await page.locator('.sample-bubble .chat-text-content').first().click();const short0=await widths();await drag(30);const short1=await widths();assert.equal(short0[0],short1[0]);assert.ok(short1[2]>short0[2]);checks.push('short bubble shows the shared wrap limit, not a misleading fixed-width resize');
 await page.locator('[data-bubble-edit="padding"]').click();assert.equal(await handle().count(),0);assert.equal(await page.locator('.sample-bubble.selected .pad-handle:visible').count(),4);await page.evaluate(()=>{$('linkPadding').checked=false});
 const max=(await theme()).layout.maxWidth;const pad=page.locator('.sample-bubble.selected .pad-handle.left'),pr=await pad.boundingBox();await page.mouse.move(pr.x+4,pr.y+12);await page.mouse.down();await page.mouse.move(pr.x+24,pr.y+12,{steps:4});await page.mouse.up();assert.equal((await theme()).layout.maxWidth,max);assert.ok((await theme()).bubble.padding.left>14);await page.screenshot({path:out+'/padding.png'});checks.push('padding mode has four separate handles, no width handle, and never changes wrap width');
 await page.locator('[data-padding-input="padLeft"]').fill('100');assert.equal((await theme()).bubble.padding.left,100);assert.equal((await theme()).layout.maxWidth,max);
 await page.locator('[data-bubble-edit="wrap"]').click();await page.locator('#bubbleWidthInput').fill('480');assert.equal((await theme()).layout.maxWidth,480);await page.locator('#bubbleWidthInput').blur();
 const exportedTheme=await theme(),css=await page.evaluate(()=>generateCss(theme(),'weflab'));assert.match(css,/width:fit-content!important/);assert.doesNotMatch(css,/width:480px!important/);
 const download=page.waitForEvent('download');await page.locator('#saveDesignTop').click();await(await download).saveAs(out+'/design.json');await configure({maxWidth:700,padLeft:0});await page.locator('#designFile').setInputFiles(out+'/design.json');await page.waitForFunction(()=>$('maxWidth').value==='480');assert.deepEqual((await theme()).bubble.padding,exportedTheme.bubble.padding);assert.equal((await theme()).bubble.fitToText,undefined);checks.push('numeric controls and design roundtrip preserve separate width/padding with content-fit export');
 const provider=await readFile('output/chat-export-audit-20260920/weflab-0.css','utf8'),fixture=await browser.newPage({viewport:{width:900,height:1000}});await fixture.route('**/*',r=>r.abort());
 for(const adapter of ['generic','weflab']){
  const measurements=[];
  for(const width of [560,360]){
   const t=structuredClone(exportedTheme);t.layout.maxWidth=width;t.bubble.padding.left=14;t.bubble.padding.right=14;
   const output=await page.evaluate(({t,adapter})=>generateCss(t,adapter),{t,adapter});
   const messages=['안녕하세요!','ㅋ','아주 긴 채팅 테스트입니다 ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ'];
   const markup=adapter==='weflab'?`<div id="page_wrap" class="chat init"><div class="page_area chat platform_1 item_chat_theme_normal item_chat_align_normal item_chat_direction_left"><div class="chat_wrap"><div class="chat_area"><div class="chat_list">${messages.map(m=>`<div class="chat_box afreeca chat"><div class="inner_box"><p class="text">${m}</p></div></div>`).join('')}</div></div></div></div></div>`:`<div class="chat-stage"><div class="chat-list">${messages.map(m=>`<div class="chat-message"><span class="text">${m}</span></div>`).join('')}</div></div>`;
   await fixture.setContent(`<style>${adapter==='weflab'?provider:''}</style><style>${output}</style><style>#page_wrap{width:720px;height:800px}.page_area.chat,.chat_wrap,.chat_area{width:100%;height:100%}*,*::before,*::after{animation:none!important;transition:none!important}</style>${markup}`);await fixture.evaluate(()=>document.fonts.ready);
   const result=await fixture.locator(adapter==='weflab'?'.chat_box':'.chat-message').evaluateAll(es=>es.map(e=>{const text=e.querySelector('.text'),r=document.createRange();r.selectNodeContents(text);return{width:e.getBoundingClientRect().width,lines:new Set([...r.getClientRects()].map(r=>Math.round(r.top))).size}}));measurements.push(result);await fixture.screenshot({path:out+'/'+adapter+'-'+width+'.png'});
  }
  assert.equal(measurements[0][0].width,measurements[1][0].width);assert.equal(measurements[0][1].width,measurements[1][1].width);assert.ok(measurements[1][2].width<measurements[0][2].width);assert.ok(measurements[1][2].lines>measurements[0][2].lines);checks.push(adapter+' rendered export reflows long messages and preserves short natural widths');
 }
 await page.locator('.sample-bubble .chat-text-content').nth(2).click();await page.setViewportSize({width:390,height:844});await page.locator('#showPreview').click();assert.ok(await page.locator('#bubbleEditToolbar').isVisible());const toolbar=await page.locator('#bubbleEditToolbar').boundingBox();assert.ok(toolbar.x>=0&&toolbar.x+toolbar.width<=391);await page.screenshot({path:out+'/mobile.png'});checks.push('mobile toolbar remains within viewport');
 assert.deepEqual(errors,[]);await writeFile(out+'/wrap.json',JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser.close()}
