// Network.enable does not replay the creation of an already-open socket.
// Before binding its requestId, prove this dedicated page has exactly one
// live WebSocket owned by the expected broadcaster. New sockets have explicit
// creation events; unrelated IDs are ignored, never parsed or used as a stop.
export function createSocketScope(owner){
  let authorized=false,selected=null;const created=new Map();
  const matches=url=>{try{const u=new URL(url);return u.protocol==='wss:'&&/^chat-[0-9a-f]{8}\.sooplive\.com$/i.test(u.hostname)&&u.pathname==='/Websocket/'+owner&&!u.search&&!u.hash}catch{return false}};
  return {
    authorize(inventory){
      if(inventory?.total!==1||inventory?.matched!==1||inventory?.open!==1)throw Error('original_socket_inventory_ambiguous');
      const matching=[...created].filter(([,yes])=>yes);
      if(matching.length>1)throw Error('original_socket_inventory_ambiguous');
      if(matching.length===1)selected=matching[0][0];
      authorized=true;
    },
    accept(event){
      const id=event.params?.requestId;
      if(event.method==='Network.webSocketCreated'){
        if(typeof id!=='string'||!id||created.size>=64)throw Error('original_socket_inventory_ambiguous');
        const expected=matches(event.params.url);created.set(id,expected);
        if(authorized&&expected&&id!==selected)throw Error('original_socket_replaced');
        return false;
      }
      if(!authorized||typeof id!=='string'||!id)return false;
      if(selected)return selected===id;
      if(created.has(id))return false;
      if(!['Network.webSocketFrameReceived','Network.webSocketFrameSent'].includes(event.method))return false;
      // The only pre-existing live socket was checked above. No first-frame
      // content heuristic, tokens, raw payload logging or page mutation.
      selected=id;return true;
    }
  };
}

export async function inspectSocketInventory(client,owner){
  const group='byeollog-observation-inventory';
  try{
    const p=await client.send('Runtime.evaluate',{expression:'WebSocket.prototype',objectGroup:group});
    if(!p.result?.objectId)throw Error('original_socket_inventory_unavailable');
    const q=await client.send('Runtime.queryObjects',{prototypeObjectId:p.result.objectId,objectGroup:group});
    if(!q.objects?.objectId)throw Error('original_socket_inventory_unavailable');
    const r=await client.send('Runtime.callFunctionOn',{objectId:q.objects.objectId,returnByValue:true,
      arguments:[{value:owner}],functionDeclaration:`function(owner){const live=this.filter(s=>s.readyState!==3);const matching=live.filter(s=>{try{const u=new URL(s.url);return u.protocol==='wss:'&&/^chat-[0-9a-f]{8}\\.sooplive\\.com$/i.test(u.hostname)&&u.pathname==='/Websocket/'+owner&&!u.search&&!u.hash}catch{return false}});return {total:live.length,matched:matching.length,open:matching.filter(s=>s.readyState===1).length}}`});
    if(r.exceptionDetails)throw Error('original_socket_inventory_unavailable');
    return r.result?.value;
  }finally{await client.send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{})}
}
