// Keep the workspace sequencer's work pending until a durable write succeeds.
// Only storage/capacity faults are retried; malformed inputs are not hidden.
const RETRYABLE=new Set(['outbox_full','outbox_disk_reserve','ENOSPC','EDQUOT','EIO','EBUSY','EACCES','EPERM','EROFS','ENOENT','EMFILE','ENFILE']);
export async function enqueueDurably(outbox,body,{onBlocked=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let attempt=0,lastNotice=0;
  for(;;){
    try{return await outbox.enqueue(body)}catch(error){
      if(!RETRYABLE.has(error?.code))throw error;
      const now=Date.now();attempt++;
      if(attempt===1||now-lastNotice>=30000){lastNotice=now;onBlocked({code:error.code,attempt})}
      await sleep(Math.min(5000,250*2**Math.min(attempt-1,5)));
    }
  }
}
