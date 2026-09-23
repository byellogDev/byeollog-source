import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {cdpClient} from '../../services/soop-gateway/services/soop-chat-gateway/cdp-client.mjs';
import {singleFlight,sleep} from '../../services/soop-gateway/services/soop-chat-gateway/single-flight.mjs';

class Socket extends EventTarget{
  static last;readyState=0;sent=[];closeCount=0;
  constructor(){super();Socket.last=this}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'))}
  send(value){this.sent.push(JSON.parse(value))}
  close(){this.closeCount++;this.readyState=3;this.dispatchEvent(new Event('close'))}
  reply(id,result){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})}))}
}
test('CDP handshake and unanswered command both terminate and release pending calls',async()=>{
  for(const opened of [false,true]){
    let closed=0;
    const client=cdpClient('ws://fixture',null,()=>closed++,{WebSocketImpl:Socket,timeoutMs:20});
    if(opened)Socket.last.open();
    const results=await Promise.allSettled([client.send('one'),client.send('two')]);
    assert.ok(results.every(x=>x.status==='rejected'&&x.reason.code==='browser_command_timeout'));
    assert.equal(closed,1);assert.equal(Socket.last.closeCount,1);
    await assert.rejects(client.send('late'),{code:'browser_debug_closed'});
  }
});
test('CDP response and close settle once; late responses are ignored',async()=>{
  let closed=0;
  const client=cdpClient('ws://fixture',null,()=>closed++,{WebSocketImpl:Socket,timeoutMs:100});
  const result=client.send('one');Socket.last.open();Socket.last.reply(1,{ok:true});
  assert.deepEqual(await result,{ok:true});
  const waiting=client.send('two');client.close();
  await assert.rejects(waiting,{code:'browser_debug_closed'});
  Socket.last.reply(2,{ok:true});client.close();assert.equal(closed,1);
});
test('lease or heartbeat overlap shares one call and failures release the gate',async()=>{
  let release,calls=0;
  const run=singleFlight(async()=>{calls++;await new Promise(r=>release=r);throw Error('temporary')});
  const a=run(),b=run();assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);
  release();await Promise.allSettled([a,b]);
  const c=run();await Promise.resolve();assert.equal(calls,2);release();await assert.rejects(c,/temporary/);
});
test('offline polling sleeps do not accumulate abort listeners',async()=>{
  const abort=new AbortController();
  for(let i=0;i<30;i++)await sleep(1,abort.signal);
  assert.equal(getEventListeners(abort.signal,'abort').length,0);
  const pending=sleep(60000,abort.signal);abort.abort();await pending;
  await sleep(60000,abort.signal);assert.equal(getEventListeners(abort.signal,'abort').length,0);
});
