// Every command (including the opening handshake) is bounded. A timed-out
// channel is closed because a late createTarget response has unknown ownership.
export function cdpClient(url,onEvent,onClosed=()=>{},{WebSocketImpl=WebSocket,timeoutMs=15000}={}){
  const socket=new WebSocketImpl(url),pending=new Map();let id=0,closed=false;
  const fail=code=>Object.assign(new Error('Browser command unavailable'),{code});
  const finish=code=>{
    if(closed)return;
    closed=true;
    for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(fail(code))}
    pending.clear();
    try{socket.close()}catch{}
    onClosed();
  };
  socket.addEventListener('message',event=>{
    let message;try{message=JSON.parse(event.data)}catch{return}
    if(message.id){
      const waiter=pending.get(message.id);if(!waiter)return;
      pending.delete(message.id);clearTimeout(waiter.timer);
      message.error?waiter.reject(fail('browser_command_failed')):waiter.resolve(message.result||{});
    }else onEvent?.(message);
  });
  socket.addEventListener('close',()=>finish('browser_debug_closed'));
  socket.addEventListener('error',()=>finish('browser_debug_failed'));
  return {
    send(method,params={},commandTimeoutMs=timeoutMs){
      if(closed)return Promise.reject(fail('browser_debug_closed'));
      const messageId=++id;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish('browser_command_timeout'),commandTimeoutMs);
        pending.set(messageId,{resolve,reject,timer});
        const send=()=>{
          if(closed||!pending.has(messageId))return;
          try{socket.send(JSON.stringify({id:messageId,method,params}))}catch{finish('browser_debug_failed')}
        };
        if(socket.readyState===1)send();else socket.addEventListener('open',send,{once:true});
      });
    },
    close(){finish('browser_debug_closed')}
  };
}
