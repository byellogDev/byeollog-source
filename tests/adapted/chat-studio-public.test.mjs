import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PUBLIC_FILES} from '../../apps/web/scripts/build-public-assets.mjs';
const root=auditURL('../',import.meta.url);
test('public chat editor has no inline script handlers and forbids network connections',async()=>{
 const html=await readFile(auditURL('chat-studio.html',root),'utf8');
 const config=JSON.parse(await readFile(auditURL('vercel.json',root),'utf8'));
 const csp=config.headers.find(r=>r.source==='/chat-studio').headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.match(csp,/connect-src 'none'/);assert.match(csp,/script-src-attr 'none'/);assert.match(csp,/object-src 'none'/);assert.doesNotMatch(csp,/unsafe-eval/);
 assert.doesNotMatch(html,/\son\w+\s*=/i);assert.doesNotMatch(html,/<script(?![^>]*src=)[^>]*>/i);
 for(const [,src] of html.matchAll(/(?:src|href)="(\/assets\/chat-studio[^"?]*)"/g))assert.ok(PUBLIC_FILES.includes(src.slice(1)),src);
 for(const file of ['assets/chat-studio.js','assets/chat-studio-core.js']){
  const js=await readFile(auditURL(file,root),'utf8');assert.doesNotMatch(js,/\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest|EventSource)\s*\(|sendBeacon\s*\(/);
 }
});
