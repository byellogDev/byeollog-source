import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runTrialServer} from './trial-server.mjs';

export async function runProductionServer(config,directory,signal,{fetchImpl=fetch,runWorker=runTrialServer}={}){
  if(!/^https:\/\/[a-z]+\.supabase\.co$/.test(config.supabaseUrl)||!config.publishableKey||config.serverSecret?.length<32)throw Error('overlay_config');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const workers=new Map();
  async function rpc(action){
    const r=await fetchImpl(config.supabaseUrl+'/rest/v1/rpc/byeollog_overlay_runtime_v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{apikey:config.publishableKey,'content-type':'application/json'},body:JSON.stringify({p_secret:config.serverSecret,p_request:{action}})});
    if(!r.ok)throw Error('overlay_rpc_'+r.status);return r.json();
  }
  try{
    while(!signal.aborted){
      let error=null,publication=null;
      try{
        const discovery=await rpc('discover');
        if(!Array.isArray(discovery.campaigns))throw Error('overlay_discovery_shape');
        const wanted=new Set();
        for(const item of discovery.campaigns){
          if(!/^[a-f0-9-]{36}$/.test(item.workspaceId))throw Error('overlay_scope');
          wanted.add(item.workspaceId);
          const signature=JSON.stringify(item.config),previous=workers.get(item.workspaceId);
          if(previous&&previous.signature!==signature){previous.stop.abort();await previous.task;workers.delete(item.workspaceId);}
          if(!workers.has(item.workspaceId)){
            const stop=new AbortController(),state={stop,signature,error:null};
            // An unexpected exit remains visible; never silently restart a failed worker.
            state.task=runWorker({...config,workspaceId:item.workspaceId},path.join(directory,item.workspaceId),stop.signal)
              .catch(e=>{state.error=/^[a-z_]+$/.test(e.message)?e.message:'overlay_worker_stopped';});
            workers.set(item.workspaceId,state);
          }
        }
        for(const [id,state] of workers)if(!wanted.has(id)){state.stop.abort();await state.task;workers.delete(id);}
        publication=await rpc('publish');
      }catch(e){error=/^overlay_[a-z_0-9]+$/.test(e.message)?e.message:'overlay_tick_failed';}
      fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({at:new Date().toISOString(),workers:workers.size,
        failed:[...workers.values()].filter(w=>w.error).length,error,publication,rss:process.memoryUsage().rss}));
      await new Promise(resolve=>{const t=setTimeout(done,10000);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    }
  }finally{for(const w of workers.values())w.stop.abort();await Promise.all([...workers.values()].map(w=>w.task));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const stop=new AbortController();for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>stop.abort());
  await runProductionServer(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),path.resolve(process.argv[3]),stop.signal);
}
