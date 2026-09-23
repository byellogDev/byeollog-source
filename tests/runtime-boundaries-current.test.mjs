import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeProxyHandler} from '../apps/web/lib/runtime-proxy.js';
import {createInternalRuntimeHandler,selectLoginRuntime,selectDataRuntime,selectNativeRouletteRuntime,allowAdminLogin,allowCollectorLogin,allowAdminData,allowPublicData} from '../apps/web/lib/runtime-isolation.js';
const token='a'.repeat(64);
const env={BYEOLLOG_RUNTIME:'frontend',BYEOLLOG_ADMIN_RUNTIME_URL:'https://audit-admin.vercel.app',BYEOLLOG_ADMIN_RUNTIME_TOKEN:token,BYEOLLOG_COLLECTOR_RUNTIME_URL:'https://audit-collector.vercel.app',BYEOLLOG_COLLECTOR_RUNTIME_TOKEN:'b'.repeat(64),BYEOLLOG_PUBLIC_RUNTIME_URL:'https://audit-public.vercel.app',BYEOLLOG_PUBLIC_RUNTIME_TOKEN:'c'.repeat(64)};
const adminEnv={BYEOLLOG_RUNTIME:'admin',BYEOLLOG_RUNTIME_TOKEN:token,SUPABASE_URL:'https://audit.invalid',SUPABASE_SECRET_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture',SESSION_SECRET:'fixture'};
const response=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v},status(n){this.statusCode=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},end(){return this}});
test('normal account flows remain on admin while collector and public reads stay isolated',()=>{
 for(const operation of ['login','signup','soop-start','soop-callback','soop-status','soop-disconnect','soop-diagnose','reset-password','change-password'])assert.equal(selectLoginRuntime({query:{operation}}),'admin');
 for(const kind of ['event','heartbeat']){const req={query:{operation:'soop-gateway'},body:{kind}};assert.equal(selectLoginRuntime(req),'collector');assert.equal(allowCollectorLogin(req),true);assert.equal(allowAdminLogin(req),false);}
 for(const kind of ['lease','reconcile']){const req={query:{operation:'soop-gateway'},body:{kind}};assert.equal(selectLoginRuntime(req),'admin');assert.equal(allowCollectorLogin(req),false);assert.equal(allowAdminLogin(req),true);}
 for(const operation of ['deployment-asset','public-workspace','public-bangsel','public-upbo-page','public-viewer','public-roulette']){const req={query:{operation}};assert.equal(selectDataRuntime(req),'public');assert.equal(allowAdminData(req),false);assert.equal(allowPublicData(req),true);}
 assert.equal(selectDataRuntime({query:{operation:'task-completion-history'}}),'admin');assert.equal(selectNativeRouletteRuntime({query:{operation:'soop-chat'}}),'collector');
});
test('proxy preserves session cookies, origin, raw payload and multiple logout cookies',async()=>{
 let observed;
 const proxy=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/logout',env,fetcher:async(url,options)=>{
  observed={url,options};const h=new Headers({'content-type':'application/json'});h.append('set-cookie','session=; Max-Age=0; HttpOnly; Secure');h.append('set-cookie','soop=; Max-Age=0; HttpOnly; Secure');return new Response('{"ok":true}',{status:200,headers:h});
 }});
 const res=response();await proxy({method:'POST',query:{operation:'logout',__destination:'https://invalid.example'},headers:{cookie:'session=fixture','content-type':'application/json',origin:'https://byeollog.com','x-byeollog-runtime-token':'attacker'},body:'{"fixed":"payload"}'},res);
 assert.equal(res.statusCode,200);assert.equal(observed.url,'https://audit-admin.vercel.app/api/logout?operation=logout');assert.equal(observed.options.headers.get('cookie'),'session=fixture');assert.equal(observed.options.headers.get('origin'),'https://byeollog.com');assert.equal(observed.options.headers.get('x-byeollog-runtime-token'),token);assert.equal(observed.options.body.toString(),'{"fixed":"payload"}');assert.equal(res.headers['set-cookie'].length,2);assert.equal(observed.options.redirect,'manual');
});
test('OAuth redirect and attempt cookie cross the frontend proxy without following the provider',async()=>{
 const proxy=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/login',env,fetcher:async()=>new Response(null,{status:302,headers:{location:'https://auth.sooplive.co.kr/fixture','set-cookie':'attempt=fixture; SameSite=Lax; Secure; HttpOnly'}})});
 const res=response();await proxy({method:'GET',query:{operation:'soop-start'},headers:{}},res);assert.equal(res.statusCode,302);assert.equal(res.headers.location,'https://auth.sooplive.co.kr/fixture');assert.match(res.headers['set-cookie'][0],/SameSite=Lax/);
});
test('direct runtime calls reject missing tokens and normalize trusted forwarded host',async()=>{
 let reached=0;const handler=createInternalRuntimeHandler(async(req,res)=>{reached++;assert.equal(req.headers.host,'byeollog.com');assert.equal(req.headers['x-byeollog-runtime-token'],undefined);return res.status(200).json({ok:true})},{runtime:'admin',env:adminEnv});
 const denied=response();await handler({headers:{}},denied);assert.equal(denied.statusCode,404);assert.equal(reached,0);
 const ok=response();await handler({headers:{host:'attacker.invalid','x-byeollog-runtime-token':token}},ok);assert.equal(ok.statusCode,200);assert.equal(reached,1);
});
test('frontend fails closed when privileged database credentials appear in its environment',async()=>{
 let called=false;const proxy=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/data',env:{...env,SUPABASE_SERVICE_ROLE_KEY:'unexpected'},fetcher:async()=>{called=true}});
 const res=response();await proxy({method:'GET',headers:{}},res);assert.equal(res.statusCode,503);assert.equal(called,false);
});
