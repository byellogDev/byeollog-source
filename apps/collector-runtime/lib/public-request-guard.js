import {createHash} from 'node:crypto';
import {clientIp} from './rate-limit.js';
// Instance-local first line of defense. No database writes or retained raw IPs.
// This complements platform protection; it is not a distributed global quota.
const counters=new Map();const WINDOW=60000,LIMIT=1200,MAX_KEYS=4096;
const storeWindows=new WeakMap();
export function allowPublicRequest(req,{now=Date.now(),counters:store=counters}={}){
 const window=Math.floor(now/WINDOW),key=createHash('sha256').update(clientIp({...req,headers:req.headers||{}}).slice(0,200)).digest('hex');
 if(storeWindows.get(store)!==window){store.clear();storeWindows.set(store,window)}
 let entry=store.get(key);
 if(!entry){
  if(store.size>=MAX_KEYS)return {allowed:false,retryAfter:1};
  entry={window,hits:0};store.set(key,entry);
 }
 entry.hits++;
 return {allowed:entry.hits<=LIMIT,retryAfter:Math.max(1,Math.ceil(((window+1)*WINDOW-now)/1000))};
}
const pending=new Map();
export async function coalescePublicRead(key,read){
 if(pending.has(key))return pending.get(key);
 if(pending.size>=256)return read();
 const promise=Promise.resolve().then(read);pending.set(key,promise);
 try{return await promise}finally{if(pending.get(key)===promise)pending.delete(key)}
}
