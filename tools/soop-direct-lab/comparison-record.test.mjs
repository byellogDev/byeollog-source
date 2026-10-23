import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonRecord,comparisonDifference} from './comparison-record.mjs';
import {encodePacket,decodePackets} from './protocol.mjs';
import {fixtures} from './fixtures.mjs';
const salt='synthetic-comparison-salt'.repeat(2),room={broadcasterId:'lab0',chatNumber:1000};
const gift=fixtures().find(x=>x.code===18);
const record=(fields=gift.fields,r=room)=>comparisonRecord(decodePackets(encodePacket(18,fields))[0],r,salt,2000);
test('unused balloon fields change diagnostic fingerprints, not business equality',()=>{
 for(const i of [4,5,6,9,10]){
  const fields=[...gift.fields];fields[i]='synthetic-changed';const a=record(),b=record(fields);
  assert.equal(a.digest,b.digest);assert.notEqual(a.rawDigest,b.rawDigest);
  assert.deepEqual(comparisonDifference(a,b).wireFields,[i]);
  assert.deepEqual(comparisonDifference(a,b).businessFields,[]);
 }
});
test('actor, quantity and image differences remain business mismatches with named fields',()=>{
 for(const [i,value,key]of [[1,'different-user','message.userId'],[2,'different-name','message.userNickname'],[3,'99','message.count'],[7,'otherimage','message.imageUrl']]){
  const fields=[...gift.fields];fields[i]=value;const a=record(),b=record(fields);
  assert.notEqual(a.digest,b.digest);assert(comparisonDifference(a,b).businessFields.includes('event.'+key));
 }
 assert.notEqual(record().digest,record(gift.fields,{...room,chatNumber:1001}).digest);
 assert.throws(()=>record(gift.fields,{...room,broadcasterId:'lab1'}),/owner/);
});
test('diagnostic serialization contains no raw actor, content or credentials and excludes authentication packets',()=>{
 const out=JSON.stringify(record());for(const value of ['synthetic-user','합성시청자','lab0'])assert(!out.includes(value));
 assert.throws(()=>comparisonRecord(decodePackets(encodePacket(16,['SECRET-TOKEN']))[0],room,salt),/not_content/);
});
test('ignored summaries are explicit and diagnostic shape is bounded',()=>{
 const r=comparisonRecord(decodePackets(encodePacket(125,['anything']))[0],room,salt);
 assert.equal(r.semanticKind,'ignored');
 assert.throws(()=>record(Array(257).fill('x')),/capacity/);
});
