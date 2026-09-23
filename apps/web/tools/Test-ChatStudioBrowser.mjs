import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=process.env.CHAT_BROWSER_OUT||'output/chat-studio-fix-20260920';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext({viewport:{width:1440,height:960},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage(),errors=[],requests=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));page.on('dialog',d=>d.accept());
const base=process.env.CHAT_STUDIO_URL||'http://127.0.0.1:4319';
try{
 await page.goto(base+'/chat-studio');await page.waitForFunction(()=>window.__CHAT_THEME_READY__&&window.ByeollogChatStudio);
 assert.equal(await page.locator('h1').textContent(),'채팅창 꾸미기');checks.push('public editor ready, no sign-in');
 await page.locator('[data-adapter-choice="weflab"]').click();
 await page.locator('#guideDismiss').click();
 await page.locator('#patternPreset').selectOption('dots');
 const save=page.waitForEvent('download');await page.locator('#saveDesignTop').click();const download=await save;const saved=out+'/roundtrip.json';await download.saveAs(saved);
 const raw=JSON.parse(await readFile(saved,'utf8'));assert.equal(raw.pattern.preset,'dots');assert.equal(raw.adapter,'weflab');checks.push('design download');
 await page.locator('#patternPreset').selectOption('grid');await page.locator('#designFile').setInputFiles(saved);await page.waitForFunction(()=>document.getElementById('patternPreset').value==='dots');
 assert.equal(await page.evaluate(()=>theme().pattern.preset),'dots');checks.push('design file roundtrip');
 // Exact equality with v0.35 would preserve the defects fixed by the rendered export suite.
 const variants=await page.evaluate(()=>['none','dots','grid','diagonal','cross','checker','waves','sparkle'].flatMap(preset=>['weflab','generic'].map(adapter=>{const t=theme();t.pattern.preset=preset;const css=generateCss(t,adapter);return{adapter,valid:css.length>1000&&!css.includes('inset:-240px')}})));
 assert.equal(variants.every(x=>x.valid),true);checks.push('16 adapter/pattern combinations generate bounded CSS');
 assert.equal((await page.evaluate(()=>runPlacementRegressionTests())).pass,true);checks.push('36 placement cases');
 await page.locator('#applyBtn').click();await page.locator('#copyCss').click();
 assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),await page.locator('#output').inputValue());checks.push('CSS clipboard');await page.locator('#exportClose').click();
 const bad={...raw,decorations:[{dataUrl:'https://attacker.invalid/image.png',name:'unsafe'}]};
 await writeFile(out+'/invalid.json',JSON.stringify(bad));
 const before=await page.evaluate(()=>JSON.stringify(theme()));await page.locator('#designFile').setInputFiles(out+'/invalid.json');await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.error==='true');assert.equal(await page.evaluate(()=>JSON.stringify(theme())),before);checks.push('bad import rejected without losing current design');
 const invalidValues=await page.evaluate(async raw=>{const cases=[{...raw,bubble:{...raw.bubble,background:'red;} body{display:none'}},{...raw,layout:{...raw.layout,gap:1e12}},{...raw,version:999}];let rejected=0;for(const x of cases)try{await ByeollogChatStudio.validateDesign(x)}catch{rejected++}return rejected},raw);assert.equal(invalidValues,3);checks.push('schema/CSS injection/range validation');
 await page.locator('#imageUpload').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64')});
 await page.waitForFunction(()=>theme().decorations.length===1);checks.push('local image upload');
 await page.evaluate(()=>{Object.assign(decorations[0],{positionMode:'smart',xTarget:'free',yTarget:'free',xSelf:'right',ySelf:'bottom',xRatio:33,yRatio:67});refresh()});
 const imageSave=page.waitForEvent('download');await page.locator('#saveDesignTop').click();await(await imageSave).saveAs(out+'/image-design.json');await page.locator('#designFile').setInputFiles(out+'/image-design.json');await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.startsWith('디자인을 불러왔습니다.'));assert.equal(await page.evaluate(()=>theme().decorations.length),1);assert.deepEqual(await page.evaluate(()=>{const l=theme().decorations[0];return[l.xTarget,l.yTarget,l.xSelf,l.ySelf,l.xRatio,l.yRatio]}),['free','free','right','bottom',33,67]);checks.push('free-position image download/import roundtrip');
 await page.screenshot({path:out+'/desktop.png'});
 for(const width of [320,390,768,1024,1920]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${width}`);
  if(width<761){await page.locator('#showEditor').click();await page.locator('[data-open-settings="pattern"]').click();assert.equal(await page.evaluate(()=>{const r=document.getElementById('settingsModal').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight}),true,`dialog ${width}`);await page.locator('#settingsClose').click();await page.locator('#showPreview').click();await page.locator('#applyBtn').click();assert.equal(await page.locator('#copyCss').isVisible(),true);await page.locator('#exportClose').click();await page.screenshot({path:out+`/mobile-preview-${width}.png`});await page.locator('#showEditor').click();await page.screenshot({path:out+`/mobile-editor-${width}.png`})}
 }
 checks.push('320/390/768/1024/1920 widths, dialogs and mobile screen switching');
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(u=>/^https?:/.test(u)&&!u.startsWith(base+'/')),[]);assert.equal(requests.some(u=>u.includes('/api/')),false);checks.push('no runtime errors, API calls or external requests');
 const report={pass:true,checks,requests:requests.length,errors};await writeFile(out+'/browser-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){await page.screenshot({path:out+'/failure.png'});await writeFile(out+'/browser-verification.json',JSON.stringify({pass:false,checks,error:e.message,errors},null,2));throw e}finally{await browser.close()}
