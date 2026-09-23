import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_BASE='https://byeollog.com';
const DEFAULT_TIMEOUT_MS=10_000;
const EXPECTATIONS=Object.freeze([
  {id:'home',path:'/',statuses:[200]},
  {id:'login',path:'/login',statuses:[200]},
  {id:'signup',path:'/signup',statuses:[200],bodyIncludes:['스트리머 회원가입']},
  {
    id:'signup-client-account-lock',path:'/assets/signup-page.js',statuses:[200],
    bodyIncludes:['기존 별록 계정으로 로그인'],
    bodyExcludes:['switch=logout','switch=authorize','다른 SOOP 계정으로 연결']
  },
  {id:'signup-status',path:'/api/auth/soop/signup/status',statuses:[200],bodyIncludes:['connected']},
  {
    id:'signup-account-switch-authorize-disabled',
    path:'/api/auth/soop/signup/start?switch=authorize',statuses:[403],bodyIncludes:['soop_account_switch_disabled']
  },
  {
    id:'signup-account-switch-logout-disabled',
    path:'/api/auth/soop/signup/start?switch=logout',statuses:[403],bodyIncludes:['soop_account_switch_disabled']
  },
  {id:'session-redirect',path:'/dashboard/signatures',statuses:[301,302,303,307,308],location:/\/login(?:[?#]|$)/},
  {id:'retired-wallpaper-page',path:'/dashboard/wallpaper',statuses:[301,302,303,307,308],location:/\/dashboard\/signatures(?:[?#]|$)/},
  {id:'retired-roulette-overlay',path:'/api/auth/soop/roulette-overlay/poll',statuses:[404]},
  {id:'agent-feed',path:'/agent-updates/stable/win-x64.json',statuses:[200],json:true},
  {id:'agent-download',path:'/agent/download',statuses:[301,302,303,307,308]}
]);

function percentile(values,ratio){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*ratio)-1)];
}

function safeBaseUrl(value){
  const url=new URL(value||DEFAULT_BASE);
  const loopback=['localhost','127.0.0.1','::1'].includes(url.hostname);
  if((url.protocol!=='https:'&&!loopback)||url.username||url.password||url.search||url.hash){
    throw new Error('Smoke base URL must be HTTPS or a loopback development URL.');
  }
  return url;
}

async function requestOnce(base,expectation,fetchImpl,timeoutMs){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),started=performance.now();
  try{
    const response=await fetchImpl(new URL(expectation.path,base),{
      method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,
      headers:{'User-Agent':'Byeollog-Stability-Smoke/1.0'}
    });
    const latencyMs=Math.round((performance.now()-started)*10)/10;
    let detail=null,body='';
    if(expectation.json&&response.ok){
      const payload=await response.json();
      let signed={};
      try{signed=JSON.parse(Buffer.from(String(payload?.payload||''),'base64url').toString('utf8'));}catch{}
      detail={version:String(signed?.version||payload?.version||''),sequence:Number(signed?.releaseSequence??payload?.sequence)||0,hasSignature:Boolean(payload?.signature?.value||payload?.signature)};
    }
    if(expectation.bodyIncludes||expectation.bodyExcludes){
      body=await response.text();
      detail={...(detail||{}),bodyBytes:Buffer.byteLength(body,'utf8')};
    }
    const location=response.headers.get('location')||'';
    const statusOk=expectation.statuses.includes(response.status);
    const locationOk=!expectation.location||expectation.location.test(location);
    const jsonOk=!expectation.json||(detail?.version&&detail.sequence>0&&detail.hasSignature);
    const includesOk=!(expectation.bodyIncludes||[]).some(value=>!body.includes(value));
    const excludesOk=!(expectation.bodyExcludes||[]).some(value=>body.includes(value));
    const contentOk=Boolean(jsonOk&&includesOk&&excludesOk);
    return {id:expectation.id,status:response.status,latencyMs,location:location.slice(0,240)||null,detail,passed:Boolean(statusOk&&locationOk&&contentOk),error:null};
  }catch(error){
    return {id:expectation.id,status:null,latencyMs:Math.round((performance.now()-started)*10)/10,location:null,detail:null,passed:false,error:error?.name==='AbortError'?'timeout':String(error?.message||error).slice(0,240)};
  }finally{clearTimeout(timer);}
}

export async function runProductionSmoke({baseUrl=DEFAULT_BASE,rounds=2,timeoutMs=DEFAULT_TIMEOUT_MS,fetchImpl=fetch}={}){
  const base=safeBaseUrl(baseUrl),safeRounds=Math.max(1,Math.min(5,Math.trunc(Number(rounds)||2))),samples=[];
  for(let round=1;round<=safeRounds;round+=1){
    for(const expectation of EXPECTATIONS){
      samples.push({round,...await requestOnce(base,expectation,fetchImpl,timeoutMs)});
    }
  }
  const latencies=samples.map(sample=>sample.latencyMs),p95=percentile(latencies,0.95);
  const failures=samples.filter(sample=>!sample.passed);
  return {
    schemaVersion:1,mode:'read-only-production-smoke',baseUrl:base.origin,
    generatedAt:new Date().toISOString(),
    safety:{methods:['GET'],authenticatedRequests:false,databaseWrites:false,productionMutations:false},
    thresholds:{requestTimeoutMs:timeoutMs,p95WarningMs:2500},
    passed:failures.length===0,
    warning:p95>2500?'http_p95_slow':null,
    summary:{rounds:safeRounds,requests:samples.length,passed:samples.length-failures.length,failed:failures.length,p50Ms:percentile(latencies,0.5),p95Ms:p95,maxMs:Math.max(...latencies)},
    failures,samples
  };
}

function arg(name,fallback=null){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]??fallback:fallback;}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(invoked){
  const report=await runProductionSmoke({baseUrl:arg('--base-url',DEFAULT_BASE),rounds:arg('--rounds','2'),timeoutMs:Number(arg('--timeout-ms',String(DEFAULT_TIMEOUT_MS)))});
  const reportPath=arg('--report');
  if(reportPath){const path=resolve(reportPath);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(report,null,2)+'\n','utf8');}
  process.stdout.write(`${JSON.stringify({passed:report.passed,warning:report.warning,summary:report.summary,failures:report.failures,reportPath:reportPath?resolve(reportPath):null})}\n`);
  process.exitCode=report.passed?0:1;
}
