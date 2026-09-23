export function singleFlight(run){
  let pending=null;
  return (...args)=>{
    if(pending)return pending;
    pending=Promise.resolve().then(()=>run(...args)).finally(()=>{pending=null});
    return pending;
  };
}

export function sleep(ms,signal){
  if(signal?.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve()};
    const timer=setTimeout(finish,ms);
    signal?.addEventListener('abort',finish,{once:true});
  });
}
