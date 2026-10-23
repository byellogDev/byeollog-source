// Optional real Chromium/CDP contract check. All traffic stays on loopback.
// Requires CHROMIUM_BINARY and PYTHON_BINARY (Python cryptography installed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {cdpClient} from '../../services/soop-gateway/services/soop-chat-gateway/cdp-client.mjs';
import {createSocketScope,inspectSocketInventory} from './cdp-scope.mjs';
import {readCdpPackets} from './cdp-frames.mjs';
const chrome=process.env.CHROMIUM_BINARY,python=process.env.PYTHON_BINARY;
if(!chrome||!python)throw Error('Set CHROMIUM_BINARY and PYTHON_BINARY');
const base=path.resolve('.local/cdp-integration');fs.mkdirSync(base,{recursive:true});
const dir=fs.mkdtempSync(path.join(base,'byeollog-cdp-test-'));
const host='chat-7f000001.sooplive.com',scope=createSocketScope('lab0'),frames=[],ends=[];
let browser,control,monitor,server,wss,debugUrl='';
const wait=async predicate=>{const until=Date.now()+15000;while(!predicate()){if(Date.now()>until)throw Error('test_timeout');await new Promise(r=>setTimeout(r,25))}};
try{
 const cert=JSON.parse(execFileSync(python,['-c',`from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import datetime,json
k=rsa.generate_private_key(public_exponent=65537,key_size=2048)
n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'loopback-test')])
now=datetime.datetime.now(datetime.timezone.utc)
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('${host}')]),False).sign(k,hashes.SHA256())
print(json.dumps({'key':k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode(),'cert':c.public_bytes(serialization.Encoding.PEM).decode()}))`],{encoding:'utf8',windowsHide:true}));
 server=https.createServer(cert,(_req,res)=>res.end('<!doctype html><title>Loopback contract test</title>'));
 wss=new WebSocketServer({server});const sockets=new Map();
 wss.on('connection',(s,req)=>sockets.set(req.url,s));
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--ignore-certificate-errors','--remote-debugging-port=0',`--user-data-dir=${dir}`,`--host-resolver-rules=MAP ${host} 127.0.0.1`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 browser.stderr.on('data',b=>{const m=b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)debugUrl=m[1]});
 await wait(()=>debugUrl);const debug=new URL(debugUrl);
 const targets=await (await fetch(`http://${debug.host}/json/list`)).json();
 const page=targets.find(t=>t.type==='page');control=cdpClient(page.webSocketDebuggerUrl);
 await control.send('Page.navigate',{url:`https://${host}:${port}/`});
 await control.send('Runtime.evaluate',{expression:`new Promise((resolve,reject)=>{globalThis.mainSocket=new WebSocket('wss://${host}:${port}/Websocket/lab0');mainSocket.onopen=()=>resolve(true);mainSocket.onerror=reject})`,awaitPromise:true,returnByValue:true});
 await wait(()=>sockets.has('/Websocket/lab0'));
 monitor=cdpClient(page.webSocketDebuggerUrl,event=>{
  if(!event.method.startsWith('Network.webSocket'))return;
  if(!scope.accept(event))return;
  if(event.method==='Network.webSocketFrameReceived')frames.push(readCdpPackets(event.params.response));
  if(event.method==='Network.webSocketClosed')ends.push(event.params.requestId);
 });
 await monitor.send('Network.enable');
 const inventory=await inspectSocketInventory(monitor,'lab0');assert.deepEqual(inventory,{total:1,matched:1,open:1});scope.authorize(inventory);
 // Existing socket has no webSocketCreated replay. Bind its actual requestId.
 sockets.get('/Websocket/lab0').send(Buffer.from('\x1b\t000000000000'));
 await wait(()=>frames.length===1);assert.equal(frames[0].packets[0].code,0);
 await control.send('Runtime.evaluate',{expression:`new Promise(resolve=>{globalThis.otherSocket=new WebSocket('wss://${host}:${port}/unrelated');otherSocket.onopen=()=>resolve(true)})`,awaitPromise:true,returnByValue:true});
 sockets.get('/unrelated').send('not-a-soop-packet');sockets.get('/unrelated').close();
 sockets.get('/Websocket/lab0').send(Buffer.from('\x1b\t008800000000'));
 await wait(()=>frames.length===2);assert.equal(frames[1].packets[0].code,88);
 sockets.get('/Websocket/lab0').close();await wait(()=>ends.length===1);
 assert.equal(frames.length,2);assert.ok(frames.every(r=>!r.error));
 console.log(JSON.stringify({passed:true,existingSocketInventory:inventory,scopedFrames:frames.length,scopedCloses:ends.length,unrelatedSocketIgnored:true}));
}finally{
 monitor?.close();control?.close();
 if(debugUrl){const b=cdpClient(debugUrl);await b.send('Browser.close').catch(()=>{});b.close()}
 if(browser&&browser.exitCode===null){await Promise.race([once(browser,'exit'),new Promise(r=>setTimeout(r,5000))]);if(browser.exitCode===null)browser.kill()}
 for(const s of wss?.clients||[])s.terminate();wss?.close();server?.close();
 if(path.dirname(path.resolve(dir))!==base||!path.basename(dir).startsWith('byeollog-cdp-test-'))throw Error('cleanup_path_invalid');
 fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
