import {readFile} from 'node:fs/promises';
export function parseTransportPolicy(value){
 if(!value||value.schemaVersion!==1||!Array.isArray(value.directWorkspaceIds)||value.directWorkspaceIds.length>10000)throw Error('invalid_transport_policy');
 const ids=value.directWorkspaceIds;
 if(ids.some(x=>typeof x!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x))||new Set(ids).size!==ids.length)throw Error('invalid_transport_policy');
 return new Set(ids);
}
export async function readTransportPolicy(directory){
 if(!directory)return new Set();
 let text;try{text=await readFile(`${directory}/transport-policy.json`,'utf8')}catch(e){if(e.code==='ENOENT')return new Set();throw e}
 if(text.length>1024*1024)throw Error('invalid_transport_policy');
 return parseTransportPolicy(JSON.parse(text));
}
// A mode switch joins the old worker (including its durable enqueue drain)
// before installing the next writer. Policy read failures leave workers intact.
export async function reconcileTransportWorkers({workers,enabled,direct,run,onStart=()=>{},onError=()=>{}}){
 for(const [id,w] of [...workers]){
  if(enabled.has(id)&&w.transport===(direct.has(id)?'direct':'sdk'))continue;
  w.abort.abort();await w.promise;
  if(workers.get(id)===w)workers.delete(id);
 }
 for(const id of enabled){
  if(workers.has(id))continue;
  const transport=direct.has(id)?'direct':'sdk',abort=new AbortController(),worker={transport,abort,promise:null};
  workers.set(id,worker);
  worker.promise=Promise.resolve().then(()=>run(id,abort.signal,transport)).catch(e=>onError(id,e)).finally(()=>{if(workers.get(id)===worker)workers.delete(id)});
  onStart(id,transport);
 }
}
