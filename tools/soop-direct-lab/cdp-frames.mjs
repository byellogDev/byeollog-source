import {decodePackets,MAX_PACKET_BYTES} from './protocol.mjs';

const PARSE_ERRORS=new Set(['invalid_packet_size','invalid_header','invalid_packet_length','invalid_utf8','invalid_field_boundary']);
// CDP exposes WebSocket control frames as well as application messages. Only
// text/binary messages are SOOP packets. Never log payloads or request IDs.
export function readCdpPackets(response){
  const opcode=Number.isInteger(response?.opcode)?response.opcode:-1;
  const payload=response?.payloadData;
  const diagnostic={opcode,payloadChars:typeof payload==='string'?payload.length:0,byteLength:null};
  if([8,9,10].includes(opcode))return {packets:[],control:true};
  const failed=code=>({packets:[],error:{...diagnostic,code}});
  if(![1,2].includes(opcode))return failed('unsupported_opcode');
  if(typeof payload!=='string')return failed('invalid_payload');
  // Bound allocation before decoding. Binary CDP payloads are base64.
  if(payload.length>Math.ceil(MAX_PACKET_BYTES/3)*4)return failed('invalid_packet_size');
  if(opcode===2&&(payload.length%4!==0||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)))return failed('invalid_base64');
  const bytes=Buffer.from(payload,opcode===1?'utf8':'base64');
  diagnostic.byteLength=bytes.length;
  try{return {packets:decodePackets(bytes),control:false}}
  catch(error){return failed(PARSE_ERRORS.has(error?.code)?error.code:'packet_decode_failed')}
}
