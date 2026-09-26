import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {encodePacket,decodePackets,MAX_PACKET_BYTES} from './protocol.mjs';
import {readCdpPackets} from './cdp-frames.mjs';
import {buildBundle} from './build-bundle.mjs';

test('old decoder reproduces failure on valid control frames; monitor adapter skips them',()=>{
 for(const opcode of [8,9,10]){
  const payloadData=Buffer.from([3,232]).toString('base64');
  assert.throws(()=>decodePackets(Buffer.from(payloadData,'utf8')));
  assert.deepEqual(readCdpPackets({opcode,payloadData}),{packets:[],control:true});
 }
});
test('text and binary SOOP payloads preserve exact bytes and duplicate counts',()=>{
 const packet=encodePacket(18,['synthetic','한글']);
 for(const opcode of [1,2]){
  const result=readCdpPackets({opcode,payloadData:Buffer.concat([packet,packet]).toString(opcode===1?'utf8':'base64')});
  assert.equal(result.packets.length,2);for(const p of result.packets)assert.deepEqual(p.bytes,packet);
 }
});
test('ping between donations neither ends observation nor loses the next donation',()=>{
 const packet=encodePacket(18,['synthetic']);let packets=[];
 for(const response of [{opcode:2,payloadData:packet.toString('base64')},{opcode:9,payloadData:''},{opcode:10,payloadData:''},{opcode:2,payloadData:packet.toString('base64')}]){
  const result=readCdpPackets(response);assert.equal(result.error,undefined);packets.push(...result.packets);
 }
 assert.equal(packets.length,2);
});
test('malformed application packets remain errors with metadata, never content',()=>{
 const marker='private-example-do-not-log';
 const result=readCdpPackets({opcode:1,payloadData:marker});
 assert.equal(result.error.code,'invalid_header');assert.equal(result.error.byteLength,marker.length);
 assert.ok(!JSON.stringify(result).includes(marker));assert.deepEqual(Object.keys(result.error).sort(),['byteLength','code','opcode','payloadChars']);
});
test('invalid and unsupported CDP inputs fail closed',()=>{
 for(const [response,code] of [[{},'unsupported_opcode'],[{opcode:0,payloadData:''},'unsupported_opcode'],[{opcode:2},'invalid_payload'],[{opcode:2,payloadData:'%%%'},'invalid_base64'],[{opcode:2,payloadData:''},'invalid_packet_size']])assert.equal(readCdpPackets(response).error.code,code);
});
test('oversize and invalid UTF8 are not silently skipped',()=>{
 assert.equal(readCdpPackets({opcode:2,payloadData:Buffer.alloc(MAX_PACKET_BYTES+1).toString('base64')}).error.code,'invalid_packet_size');
 const packet=encodePacket(5,['x']);packet[15]=255;
 assert.equal(readCdpPackets({opcode:2,payloadData:packet.toString('base64')}).error.code,'invalid_utf8');
});
test('deployed monitor bundle executes the tested adapter and retains socket-close stop',()=>{
 const {bundle}=buildBundle();const prefix=bundle.monitor.slice(0,bundle.monitor.indexOf("import fs from 'node:fs'"));
 const context=vm.createContext({Buffer,TextDecoder});vm.runInContext(prefix.replace(/^export /gm,'')+';globalThis.adapter=readCdpPackets;',context);
 assert.equal(context.adapter({opcode:10,payloadData:''}).control,true);
 assert.equal(context.adapter({opcode:1,payloadData:'broken'}).error.code,'invalid_packet_size');
 assert.match(bundle.monitor,/const decoded=readCdpPackets\(event.params\?\.response\)/);
 assert.match(bundle.monitor,/Network.webSocketClosed/);assert.match(bundle.monitor,/halt\('original_packet_decode_failed'\)/);
 assert.doesNotMatch(bundle.monitor,/from '\.\/protocol\.mjs'/);
 const controller=fs.readFileSync(new URL('soak-controller.py',import.meta.url),'utf8');
 assert.match(controller,/kind=='original_decode_error' and source=='original'/);
});
