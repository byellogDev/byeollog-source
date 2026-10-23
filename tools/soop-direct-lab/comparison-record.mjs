import {createHmac as comparisonHmac} from 'node:crypto';
import {CONTENT_CODES,contentEvent,fault} from './protocol.mjs';

// Session-keyed fingerprints only. Authentication/control bytes cannot enter
// this recorder. The same projection is covered by the pinned SDK oracle.
export function comparisonRecord(packet,room,salt,at=Date.now()){
 if(!CONTENT_CODES.includes(packet.code))throw fault('comparison_not_content');
 if(typeof salt!=='string'||salt.length<32)throw fault('invalid_observer_salt');
 if(!Number.isSafeInteger(room.chatNumber)||room.chatNumber<1)throw fault('comparison_room_missing');
 if(packet.fields.length>256)throw fault('comparison_diagnostic_capacity');
 const event=contentEvent(packet,room);
 const mac=(domain,value)=>comparisonHmac('sha256',salt).update(domain+'\0').update(value).digest('hex');
 const fingerprint=value=>({digest:mac('field',value),bytes:Buffer.byteLength(value)});
 const business={};
 const flatten=(v,path)=>{if(v&&typeof v==='object'){for(const k of Object.keys(v).sort())flatten(v[k],path?path+'.'+k:k)}else business[path]=JSON.stringify(v)};
 flatten({room:{broadcasterId:room.broadcasterId,chatNumber:room.chatNumber},event},'');
 // Prefix-free canonical entries, including field names and value types.
 const canonical=JSON.stringify(business);
 return {schema:2,code:packet.code,at,semanticKind:event?'event':'ignored',
  digest:mac('business',canonical),rawDigest:mac('wire',packet.bytes),
  fields:packet.fields.map(fingerprint),business:Object.fromEntries(Object.entries(business).map(([k,v])=>[k,fingerprint(v)]))};
}

export function comparisonDifference(a,b){
 const wireFields=[];for(let i=0;i<Math.max(a.fields.length,b.fields.length);i++)if(a.fields[i]?.digest!==b.fields[i]?.digest||a.fields[i]?.bytes!==b.fields[i]?.bytes)wireFields.push(i);
 const businessFields=[...new Set([...Object.keys(a.business),...Object.keys(b.business)])].filter(k=>a.business[k]?.digest!==b.business[k]?.digest||a.business[k]?.bytes!==b.business[k]?.bytes);
 return {wireFields,businessFields};
}
