import http from 'node:http';

const CHATINFO='https://openapi.sooplive.com/broad/access/chatinfo';
const fail=code=>Object.assign(new Error(code),{code});

// Only room lookup is delegated. OAuth refresh and every other request retain
// their original transport. The privileged iwinv key never enters this process.
export function createEgressFetch({socketPath,owner,baselinePorts,fetchImpl=fetch,requestImpl=http.request}){
 if(!socketPath)return fetchImpl;
 if(!socketPath.startsWith('/')||socketPath.length>100||/[\x00-\x20\x7f]/.test(socketPath)||!/^\w[\w.-]{1,79}$/.test(owner))throw fail('egress_config_invalid');
 if(!Array.isArray(baselinePorts)||!baselinePorts.length||baselinePorts.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw fail('egress_config_invalid');
 return async (url,options={})=>{
  if(String(url)!==CHATINFO)return fetchImpl(url,options);
  if(options.method!=='POST'||typeof options.body!=='string')throw fail('egress_request_invalid');
  const params=new URLSearchParams(options.body),token=params.get('access_token');
  if([...params.keys()].length!==1||!token||token.length>8192||/[\x00-\x20\x7f]/.test(token))throw fail('egress_request_invalid');
  // An unavailable controller must not become a new single point of failure
  // for already-approved ports. Look up the room normally first. For an unknown
  // port the controller independently authenticates the provider response.
  const original=await fetchImpl(url,options);
  if(!original.ok)return original;
  const reader=original.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw fail('chatinfo_too_large');parts.push(value)}}finally{await reader.cancel().catch(()=>{})}
  const raw=Buffer.concat(parts);let room;
  try{room=JSON.parse(raw)}catch{throw fail('invalid_chatinfo')}
  const reply=()=>new Response(raw,{status:original.status,headers:{'Content-Type':'application/json'}});
  if(!(Number(room?.result)>0))return reply();
  if(!Array.isArray(room.data)||room.data.length!==1||room.data[0]?.id!==owner)throw fail('chatinfo_owner_mismatch');
  const port=Number(room.data[0].chat_port)+1;
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw fail('invalid_chat_address');
  if(baselinePorts.includes(port))return reply();
  const data=JSON.stringify({owner,accessToken:token});
  return new Promise((resolve,reject)=>{
   let settled=false,req;
   const finish=(error,response)=>{if(settled)return;settled=true;options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(response)};
   const abort=()=>{req?.destroy();finish(fail('egress_request_aborted'))};
   if(options.signal?.aborted){abort();return}
   req=requestImpl({socketPath,path:'/chatinfo',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)},timeout:10000},res=>{
    let length=0;const chunks=[];
    res.on('data',chunk=>{length+=chunk.length;if(length>65536){res.destroy();finish(fail('egress_response_too_large'))}else chunks.push(chunk)});
    res.on('error',()=>finish(fail('egress_response_failed')));
    res.on('end',()=>{
     const bytes=Buffer.concat(chunks);
     if(res.statusCode===503){
      let code;try{code=JSON.parse(bytes).error}catch{}
      finish(fail(typeof code==='string'&&/^egress_[a-z0-9_]{1,80}$/.test(code)?code:'egress_controller_unavailable'));return;
     }
     finish(null,new Response(bytes,{status:res.statusCode,headers:{'Content-Type':'application/json'}}));
    });
   });
   req.on('error',()=>finish(fail('egress_controller_unavailable')));
   req.on('timeout',()=>{req.destroy();finish(fail('egress_controller_timeout'))});
   options.signal?.addEventListener('abort',abort,{once:true});
   req.end(data);
  });
 };
}
