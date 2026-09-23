import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import {resolve,sep} from 'node:path';

const CLI='vercel@59.5.0';
const codeOf=result=>typeof result==='number'?result:result?.code??1;

export async function deployProduction({run=runCommand,platform=process.platform,npmCli=process.env.npm_execpath,args=process.argv.slice(2),loadManifest=()=>readFile('release-manifest.json','utf8'),loadPublicMetadata=()=>readFile('public-dist/deployment-metadata.json','utf8')}={}){
  if(args.some(argument=>argument==='--prebuilt')){
    throw new Error('Windows prebuilt output cannot be promoted to the Linux production runtime. Use the remote production build.');
  }
  if(args.length)throw new Error('Unsupported deployment arguments; bypass flags are not accepted.');

  const windows=platform==='win32';
  if(windows&&!npmCli){
    throw new Error('Run this deployment guard through `npm run deploy:production`.');
  }
  const executable=windows?process.execPath:'npx';
  const npmExecutable=windows?process.execPath:'npm';
  const npmArgs=values=>windows?[npmCli,...values]:values;
  // No production request is made if tests or source-manifest generation fail.
  for(const command of [['test'],['run','release:manifest'],['run','build:public']]){
    const code=codeOf(await run(npmExecutable,npmArgs(command)));
    if(code!==0)return code;
  }
  const manifest=JSON.parse(await loadManifest());
  if(!/^[a-f0-9]{64}$/.test(String(manifest.sourceDigest||'')))throw new Error('Source manifest digest is missing.');
  const vc=values=>windows?[npmCli,'exec','--yes','--',CLI,...values]:['--yes',CLI,...values];
  // Build a production-environment candidate WITHOUT moving the live alias.
  const candidate=await run(executable,vc(['deploy','--prod','--skip-domain','--yes','--json']),{capture:true});
  if(codeOf(candidate)!==0)return codeOf(candidate);
  const output=JSON.parse(String(candidate.stdout||''));
  const deployment=output.deployment||output;
  if(deployment.readyState!=='READY'||deployment.target!=='production'||!String(deployment.id||'').startsWith('dpl_'))throw new Error('Candidate is not a ready production deployment.');
  const url=String(deployment.url||'');
  if(!/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(url))throw new Error('Candidate URL is missing or ambiguous; production was not promoted.');
  const inspected=await run(executable,vc(['api',`/v13/deployments/${deployment.id}`,'--method','GET','--raw']),{capture:true});
  if(codeOf(inspected)!==0)throw new Error('Candidate region verification failed; production was not promoted.');
  const actualDeployment=JSON.parse(String(inspected.stdout||''));
  if(actualDeployment.id!==deployment.id||!isDeepStrictEqual(actualDeployment.regions,['hnd1']))throw new Error('Candidate must run only in Tokyo; production was not promoted.');
  const get=async (path,authenticated=false)=>{
    // CLI supplies deployment protection access; never make a candidate public.
    const result=await run(executable,vc(['curl',path,'--deployment',url,'--','--fail','--silent','--show-error','--max-time','20',...(authenticated?['--header','@.vercel/upbo-retry-private/request-header']:[])]),{capture:true});
    if(codeOf(result)!==0)throw new Error(`Candidate check failed: ${path}; production was not promoted.`);
    return String(result.stdout||'');
  };
  const localPublicMetadata=JSON.parse(await loadPublicMetadata());
  const remotePublicMetadata=JSON.parse(await get('/deployment-metadata.json'));
  if(!isDeepStrictEqual(remotePublicMetadata,localPublicMetadata)
    || remotePublicMetadata.sourceDigest!==manifest.sourceDigest
    || !/^[a-f0-9]{64}$/.test(String(remotePublicMetadata.publicDigest||''))){
    throw new Error('Candidate public artifact identity differs; production was not promoted.');
  }
  const schema=JSON.parse(await get('/api/upbo-retry?mode=schema',true));
  if(schema.schemaReady!==true)throw new Error('Production DB schema is not ready; production was not promoted.');
  for(const path of ['/','/login','/signup']){
    const html=await get(path);
    if(!/<!doctype html/i.test(html)||!html.includes('별록'))throw new Error(`Candidate page is invalid: ${path}; production was not promoted.`);
  }
  // A root-directory static deployment must not publish server source files.
  // Check actual candidate routing (unit tests cannot prove CDN precedence).
  await Promise.all(['/release-manifest.json','/package.json','/lib/auth.js','/services/soop-chat-gateway/index.mjs','/tools/Test-BackupRestorePostgres.mjs','/supabase/migrations/20260906021854_atomic_backup_restore.sql','/artifacts/obs-wallpaper-source.png','/installer/Invoke-AgentInstall.ps1','/docs/CORE_PRODUCT_ARCHITECTURE_KO.md','/test/web-security-posture.test.mjs','/lib/roulette-classification-html.js','/tools/Test-SpecialRoulettePostgres.mjs','/test/special-roulette-postgres-fixture.sql','/supabase/migrations/20260908101446_special_roulette_ingestion_receipts.sql','/supabase/migrations/20260908112310_roulette_mapping_activation.sql','/test/roulette-activation.test.mjs',"/test/wallpaper-conflict-no-retry.test.mjs","/test/fixtures/wallpaper-conflict-baseline.json","/tools/Test-WallpaperConflictPostgres.mjs","/supabase/migrations/20260908115956_wallpaper_conflict_no_retry.sql","/lib/roulette-exceptions.js","/lib/roulette-exceptions-html.js","/test/roulette-exceptions.test.mjs","/tools/Test-RouletteExceptionsPostgres.mjs","/supabase/migrations/20260908125923_roulette_exception_review.sql"].map(async path=>{
    const result=await run(executable,vc(['curl',path,'--deployment',url,'--','--silent','--show-error','--max-time','20','--output',windows?'NUL':'/dev/null','--write-out','%{http_code}']),{capture:true});
    if(codeOf(result)!==0||String(result.stdout||'').trim()!=='404')throw new Error(`Private source is publicly accessible: ${path}; production was not promoted.`);
  }));
  // A second local check catches edits/manifest regeneration during candidate build.
  if(!isDeepStrictEqual(JSON.parse(await loadManifest()),manifest))throw new Error('Local release manifest changed during verification; production was not promoted.');
  for(const file of manifest.files||[]){
    const root=resolve('.'),path=resolve(root,file.path);
    if(!path.startsWith(root+sep))throw new Error('Invalid release source path.');
    const bytes=await readFile(path);
    if(bytes.length!==file.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256){
      throw new Error(`Source file changed during candidate verification: ${file.path}; production was not promoted.`);
    }
  }
  // These checks are an unauthenticated smoke gate, NOT SOOP/Agent/OBS E2E.
  return codeOf(await run(executable,vc(['promote',url,'--yes'])));
}

function runCommand(executable,args,{capture=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{
      cwd:process.cwd(),
      env:process.env,
      shell:false,
      stdio:capture?['ignore','pipe','inherit']:'inherit'
    });
    let stdout='',overflow=false;
    if(capture)child.stdout.setEncoding('utf8').on('data',chunk=>{
      if(Buffer.byteLength(stdout)+Buffer.byteLength(chunk)>8*1024*1024){overflow=true;child.kill();return;}
      stdout+=chunk;
    });
    child.once('error',reject);
    // Capture is complete only after stdout closes, not merely process exit.
    child.once('close',(code,signal)=>{
      if(signal){
        console.error(`Production deployment terminated by ${signal}.`);
        resolve(1);
        return;
      }
      resolve(capture?{code:overflow?1:code??1,stdout}:code??1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.exitCode=await deployProduction()}
  catch(error){console.error(error);process.exitCode=1}
}
