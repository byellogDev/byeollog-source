// Research-only protocol adapter. No SDK, database, credentials or global room state.
export const MAX_PACKET_BYTES=65536;
export const CONTENT_CODES=Object.freeze([5,18,26,33,86,87,103,105,107,109,121,125]);
const utf8=new TextDecoder('utf-8',{fatal:true});
export function fault(code){return Object.assign(new Error(code),{code})}
export function encodePacket(code,fields=[],ret=0){
  if(!Number.isInteger(code)||code<0||code>9999||!Number.isInteger(ret)||ret<0||ret>99)throw fault('invalid_header');
  if(fields.some(x=>typeof x!=='string'||x.includes('\f')))throw fault('invalid_field');
  const body=Buffer.from(fields.length?'\f'+fields.join('\f')+'\f':'\f');
  if(body.length+14>MAX_PACKET_BYTES)throw fault('packet_too_large');
  return Buffer.concat([Buffer.from('\x1b\t'+String(code).padStart(4,'0')+String(body.length).padStart(6,'0')+String(ret).padStart(2,'0')),body]);
}
export function decodePackets(input){
  const data=Buffer.from(input);
  if(data.length>MAX_PACKET_BYTES||data.length<15)throw fault('invalid_packet_size');
  const packets=[];let offset=0;
  while(offset<data.length){
    if(packets.length>=128||offset+14>data.length)throw fault('invalid_packet_size');
    const h=data.subarray(offset,offset+14);
    if(h[0]!==27||h[1]!==9||!/^\d{12}$/.test(h.subarray(2).toString('ascii')))throw fault('invalid_header');
    const length=Number(h.subarray(6,12).toString()),end=offset+14+length;
    if(length<1||end>data.length)throw fault('invalid_packet_length');
    let body;try{body=utf8.decode(data.subarray(offset+14,end))}catch{throw fault('invalid_utf8')}
    if(!body.startsWith('\f')||!body.endsWith('\f'))throw fault('invalid_field_boundary');
    packets.push({code:Number(h.subarray(2,6).toString()),ret:Number(h.subarray(12,14).toString()),fields:body==='\f'?[]:body.slice(1,-1).split('\f'),bytes:data.subarray(offset,end)});
    offset=end;
  }
  return packets;
}
export function loginPacket(token){return encodePacket(16,[token,'16'])}
export function joinPacket(room,clientId,clientSecret){
  for(const s of [clientId,clientSecret])if(typeof s!=='string'||!s.length||s.length>512||/[\x00-\x20\x7f]/.test(s))throw fault('invalid_client_credentials');
  const log='log\x11'+[['is_chat_sdk','true'],['sdk_client_id',clientId],['sdk_client_secret',clientSecret]].map(([k,v])=>'\x06&\x06'+k+'\x06=\x06'+v).join('')+'\x12access_system\x11html5\x12';
  return encodePacket(2,[String(room.chatNumber),room.ticket,'5','',log]);
}
const resource='https://res.sooplive.com';
function integer(s){if(!/^[0-9]+$/.test(String(s))||!Number.isSafeInteger(Number(s))||Number(s)<=0)throw fault('invalid_donation_count');return Number(s)}
function balloonImage(count,custom,top){
  if(custom&&top!=='1'){
    if(!/^[a-zA-Z0-9_-]{1,120}$/.test(custom))throw fault('invalid_image_key');
    return `${resource}/new_player/items/balloon_${custom}.jpg`;
  }
  const step=count<10?1:count<50?2:count<100?3:count<500?4:count<1000?5:6;
  return `${resource}/new_player/items/ba_step${step}.png`;
}
// Return only fields consumed by Byeollog, not the SDK's presentation/user-status API.
export function contentEvent(packet,room){
  const {code,fields:f}=packet;
  if(!CONTENT_CODES.includes(code))return null;
  if(packet.ret!==0)throw fault('content_rejected');
  const need=n=>{if(f.length<n)throw fault('missing_event_fields')};
  let action,message;
  if(code===5||code===26||code===109){
    need(code===109?8:code===26?5:6);
    action=code===26?'MANAGER_MESSAGE':'MESSAGE';
    message={message:f[code===109?1:0].replace(/\r/g,''),userId:f[code===109?5:1],userNickname:f[code===109?6:code===26?4:5]};
  }else if([18,33,86].includes(code)){
    need(code===33?10:code===18?9:4);
    const relay=code===33,count=integer(f[relay?5:3]);
    action='BALLOON_GIFTED';message={bjId:f[relay?1:0],userId:f[relay?3:1],userNickname:f[relay?4:2],count,
      imageUrl:balloonImage(relay?Number(f[3]):count,code===86?'':f[relay?8:7],code===86?'0':f[relay?9:8]),fromVod:code===86,relaysBroad:relay};
  }else if(code===105){
    need(9);action='VIDEOBALLOON_GIFTED';message={bjId:f[1],userId:f[2],userNickname:f[3],count:integer(f[4]),imageUrl:resource+'/new_player/items/img_video_balloon.png',relaysBroad:f[8]==='1'};
  }else if([87,103,107].includes(code)){
    need(code===87?14:6);const live=code===87;
    action='ADBALLOON_GIFTED';message={bjId:f[live?1:0],userId:f[live?2:1],userNickname:f[live?3:2],count:integer(f[live?9:3]),imageUrl:f[live?8:4],fromVod:code===103,fromStation:code===107};
  }else if(code===125){return null; // Aggregate sponsor summary is not another donation.
  }else if(code===121){
    need(1);let j;try{j=JSON.parse(f[0])}catch{throw fault('invalid_mission_json')}
    if(!j||typeof j!=='object'||Array.isArray(j))throw fault('invalid_mission_json');
    if(['SETTLE','NOTICE','CHALLENGE_SETTLE','CHALLENGE_NOTICE'].includes(j.type))return null;
    if(!['GIFT','CHALLENGE_GIFT'].includes(j.type))throw fault('unknown_mission_type');
    if(typeof j.image!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(j.image))throw fault('invalid_image_key');
    action=j.type==='GIFT'?'BATTLE_MISSION_GIFTED':'CHALLENGE_MISSION_GIFTED';
    message={userId:j.user_id,userNickname:j.user_nick,count:integer(j.gift_count),imageUrl:resource+(j.type==='GIFT'?'/images/new_app/chat/mission/':'/images/chat/mission/')+j.image+'.png'};
  }
  if(message.bjId&&message.bjId!==room.broadcasterId)throw fault('event_owner_mismatch');
  if(typeof message.userId!=='string'||!message.userId||message.userId.length>180||typeof message.userNickname!=='string'||message.userNickname.length>120)throw fault('invalid_actor');
  return {action,message};
}
