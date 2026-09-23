import http from 'node:http';
import crypto from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  NATIVE_ROULETTE_TWIN_SCENARIOS,
  nativeRouletteTwinAssetByKey,
  runNativeRouletteTwinCampaign,
  runNativeRouletteTwinScenario
} from './native-roulette-digital-twin-core.mjs';
import {
  renderNativeRouletteTwinController,
  renderNativeRouletteTwinOverlay
} from './native-roulette-digital-twin-ui.mjs';

const HOST='127.0.0.1';
const DEFAULT_PORT=17_261;
const MAX_BODY_BYTES=64*1024;
const sourceDir=dirname(fileURLToPath(import.meta.url));
const repoDir=resolve(sourceDir,'..');
const defaultOutputDir=resolve(repoDir,'..','output','native-roulette-digital-twin');

function parseArgs(argv){
  const result={port:DEFAULT_PORT,headless:false,runs:1_000,seed:20260828,scenarioId:null,outputDir:defaultOutputDir};
  for(let index=0;index<argv.length;index++){
    const arg=argv[index];
    if(arg==='--headless')result.headless=true;
    else if(arg==='--port')result.port=Number(argv[++index]);
    else if(arg==='--runs')result.runs=Number(argv[++index]);
    else if(arg==='--seed')result.seed=Number(argv[++index]);
    else if(arg==='--scenario')result.scenarioId=String(argv[++index]||'');
    else if(arg==='--output-dir')result.outputDir=resolve(String(argv[++index]||''));
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if(!Number.isSafeInteger(result.port)||result.port<1_024||result.port>65_535)throw new Error('포트는 1024~65535 정수여야 합니다.');
  if(!Number.isSafeInteger(result.runs)||result.runs<1||result.runs>100_000)throw new Error('실행 횟수는 1~100000 정수여야 합니다.');
  if(!Number.isSafeInteger(result.seed))throw new Error('seed는 정수여야 합니다.');
  return result;
}

function json(res,status,value){
  const body=JSON.stringify(value);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});
  res.end(body);
}

function html(res,value){
  const body=Buffer.from(value);
  res.writeHead(200,{
    'content-type':'text/html; charset=utf-8','content-length':body.length,'cache-control':'no-store',
    'content-security-policy':"default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff'
  });
  res.end(body);
}

async function readJsonBody(req){
  let length=0;const chunks=[];
  for await(const chunk of req){
    length+=chunk.length;if(length>MAX_BODY_BYTES)throw Object.assign(new Error('요청이 너무 큽니다.'),{status:413});chunks.push(chunk);
  }
  if(length===0)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('JSON 요청만 허용합니다.'),{status:400})}
}

function safeLocalRequest(req,port){
  const host=String(req.headers.host||'').toLowerCase();
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return false;
  const origin=req.headers.origin;
  return !origin||origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`;
}

export class NativeRouletteTwinRuntime{
  constructor({seed=20260828,onComplete=null}={}){
    this.seed=seed;this.onComplete=onComplete;this.clients=new Set();this.timers=[];this.generation=0;
    this.state={running:false,completed:false,passed:null,scenarioId:null,durationMs:1,virtualNowMs:0,events:[],duplicateVisibleExecutions:0,verification:null};
  }
  snapshot(){return structuredClone(this.state)}
  _send(client,type,value){client.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)}
  broadcast(type,value){for(const client of this.clients){try{this._send(client,type,value)}catch{this.clients.delete(client)}}}
  subscribe(res){this.clients.add(res);this._send(res,'snapshot',this.snapshot());return()=>this.clients.delete(res)}
  _clear(){for(const timer of this.timers)clearTimeout(timer);this.timers=[];this.generation++}
  reset(){this._clear();this.state={running:false,completed:false,passed:null,scenarioId:null,durationMs:1,virtualNowMs:0,events:[],duplicateVisibleExecutions:0,verification:null};this.broadcast('snapshot',this.snapshot());return this.snapshot()}
  run({scenarioId,speed=1}={}){
    if(![1,2,4,10].includes(Number(speed)))throw Object.assign(new Error('재생 속도는 1, 2, 4, 10 중 하나여야 합니다.'),{status:400});
    if(!NATIVE_ROULETTE_TWIN_SCENARIOS.some(item=>item.id===scenarioId))throw Object.assign(new Error('지원하지 않는 시나리오입니다.'),{status:400});
    this._clear();const generation=this.generation;const report=runNativeRouletteTwinScenario({scenarioId,seed:this.seed++});
    const durationMs=report.timeline.at(-1)?.atMs||1;
    this.state={running:true,completed:false,passed:null,scenarioId,durationMs,virtualNowMs:0,events:[],duplicateVisibleExecutions:0,verification:null,asset:report.asset};
    this.broadcast('snapshot',this.snapshot());
    for(const event of report.timeline){
      const timer=setTimeout(()=>{
        if(generation!==this.generation)return;
        this.state.virtualNowMs=event.atMs;this.state.events.push(event);this.broadcast('event',event);
        if(event.kind==='scenario.complete'){
          this.state.running=false;this.state.completed=true;this.state.passed=report.verification.passed;this.state.verification=report.verification;
          this.broadcast('tick',this.snapshot());
          Promise.resolve(this.onComplete?.({...report,completedAt:new Date().toISOString()})).catch(()=>{});
        }else this.broadcast('tick',this.snapshot());
      },Math.max(0,Math.round(event.atMs/Number(speed))));this.timers.push(timer);
    }
    return this.snapshot();
  }
}

async function writeReport(outputDir,name,value){
  await mkdir(outputDir,{recursive:true});
  const path=resolve(outputDir,name);
  await writeFile(path,`${JSON.stringify(value,null,2)}\n`,'utf8');return path;
}

async function serveAsset(pathname,res){
  if(pathname==='/assets/roulette-spin.wav'){
    const body=await readFile(resolve(repoDir,'dormant-native-roulette-assets','audio','roulette-spin-v1.wav'));
    res.writeHead(200,{'content-type':'audio/wav','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);return true;
  }
  const match=pathname.match(/^\/assets\/roulette-preview\/([a-z0-9_]+)\.webp$/);
  if(match){
    const asset=nativeRouletteTwinAssetByKey(match[1]);if(!asset)return false;
    const body=await readFile(resolve(repoDir,asset.previewUrl.replace(/^\/assets\//,'assets/')));
    res.writeHead(200,{'content-type':'image/webp','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);return true;
  }
  const animationMatch=pathname.match(/^\/assets\/roulette-animation\/([a-z0-9_]+)\.webp$/);
  if(!animationMatch)return false;
  const asset=nativeRouletteTwinAssetByKey(animationMatch[1]);if(!asset)return false;
  let mode='full-animation';
  let body=await readFile(resolve(repoDir,'..',asset.sourceRelativePath)).catch(async error=>{
    if(error?.code!=='ENOENT')throw error;
    mode='reviewed-preview-fallback';
    return readFile(resolve(repoDir,asset.previewUrl.replace(/^\/assets\//,'assets/')));
  });
  const digest=crypto.createHash('sha256').update(body).digest('hex');
  if(mode==='full-animation'&&(body.length!==asset.byteSize||digest!==asset.contentSha256))throw new Error('local roulette WebP contract mismatch');
  if(mode==='reviewed-preview-fallback'&&(body.length!==asset.previewByteSize||digest!==asset.previewSha256))throw new Error('local roulette preview contract mismatch');
  res.writeHead(200,{'content-type':'image/webp','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff','x-byeollog-asset-mode':mode});res.end(body);return true;
}

export async function startNativeRouletteTwinServer({port=DEFAULT_PORT,seed=20260828,outputDir=defaultOutputDir}={}){
  const runtime=new NativeRouletteTwinRuntime({seed,onComplete:report=>writeReport(outputDir,'last-scenario.json',report)});
  const server=http.createServer(async(req,res)=>{
    try{
      if(!safeLocalRequest(req,port)){json(res,403,{error:'local_request_required'});return}
      const url=new URL(req.url||'/',`http://${HOST}:${port}`);
      if(req.method==='GET'&&url.pathname==='/'){html(res,renderNativeRouletteTwinController({port}));return}
      if(req.method==='GET'&&url.pathname==='/overlay'){html(res,renderNativeRouletteTwinOverlay());return}
      if(req.method==='GET'&&url.pathname==='/api/health'){json(res,200,{ok:true,mode:'local-digital-twin',productionDispatch:false});return}
      if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,runtime.snapshot());return}
      if(req.method==='GET'&&url.pathname==='/api/events'){
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});res.write(': byeollog twin stream\n\n');
        const unsubscribe=runtime.subscribe(res);req.on('close',unsubscribe);return;
      }
      if(req.method==='POST'&&url.pathname==='/api/run'){json(res,202,runtime.run(await readJsonBody(req)));return}
      if(req.method==='POST'&&url.pathname==='/api/reset'){await readJsonBody(req);json(res,200,runtime.reset());return}
      if(req.method==='POST'&&url.pathname==='/api/shutdown'){
        await readJsonBody(req);runtime.reset();json(res,202,{ok:true,shutdown:true});setTimeout(()=>server.close(),100);return;
      }
      if(req.method==='GET'&&await serveAsset(url.pathname,res))return;
      json(res,404,{error:'not_found'});
    }catch(error){json(res,error.status||500,{error:error.status?'invalid_request':'local_twin_error',message:error.status?error.message:'로컬 디지털 트윈 처리 중 오류가 발생했습니다.'})}
  });
  await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(port,HOST,resolvePromise)});
  return {server,runtime,url:`http://${HOST}:${port}/`,overlayUrl:`http://${HOST}:${port}/overlay?audio=1`};
}

async function main(){
  const options=parseArgs(process.argv.slice(2));
  if(options.headless){
    const campaign=runNativeRouletteTwinCampaign({runsPerScenario:options.runs,seed:options.seed});
    const path=await writeReport(options.outputDir,'campaign-report.json',campaign);
    process.stdout.write(`${campaign.passed?'NATIVE_ROULETTE_TWIN_PASS':'NATIVE_ROULETTE_TWIN_FAIL'}\n`);
    process.stdout.write(`runs=${campaign.runs} events=${campaign.timelineEvents} failures=${campaign.failures.length}\nreport=${path}\n`);
    if(!campaign.passed)process.exitCode=1;return;
  }
  if(options.scenarioId){
    const report=runNativeRouletteTwinScenario({scenarioId:options.scenarioId,seed:options.seed});
    const path=await writeReport(options.outputDir,'single-scenario.json',report);
    process.stdout.write(`${report.verification.passed?'NATIVE_ROULETTE_TWIN_SCENARIO_PASS':'NATIVE_ROULETTE_TWIN_SCENARIO_FAIL'}\nreport=${path}\n`);return;
  }
  const app=await startNativeRouletteTwinServer(options);
  process.stdout.write(`BYEOLLOG_NATIVE_ROULETTE_TWIN_READY\ncontroller=${app.url}\noverlay=${app.overlayUrl}\n`);
  const close=()=>app.server.close(()=>process.exit(0));process.on('SIGINT',close);process.on('SIGTERM',close);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{process.stderr.write(`${error.stack||error.message}\n`);process.exitCode=1});
}
