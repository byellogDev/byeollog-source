import crypto from 'node:crypto';
import {createSessionToken,setSessionCookie} from '../lib/auth.js';
import {sb} from '../lib/supabase-rest.js';
import {handleSignup,handleSignupStatus} from '../lib/signup.js';
import handlePassword from '../lib/password.js';
import {isRateLimited, clientIp} from '../lib/rate-limit.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';
import {handleSoopOAuthCallback,handleSoopOAuthDiagnose,handleSoopOAuthDisconnect,handleSoopOAuthStart,handleSoopOAuthStatus} from '../lib/soop-oauth.js';
import {handleSoopGatewayIngress} from '../lib/soop-gateway-api.js';
import {claimOverlayTtsSynthesis,claimRouletteOverlayCommand,finishOverlayTtsSynthesis,finishRouletteOverlayCommand,getRouletteServiceOverlayHtml,peekRouletteOverlayFollowup,recordRouletteChatDryRun,touchRouletteOverlayClient,validateRouletteOverlayService,verifyOverlayTtsAuthorization,verifyRouletteServiceOverlayToken} from '../lib/soop-roulette-service.js';
import {MANAGED_TTS_AUDIO_FRAME,MANAGED_TTS_END_FRAME,MANAGED_TTS_ERROR_FRAME,MANAGED_TTS_SAMPLE_RATE,managedOverlayTtsRuntime,managedTtsFrame} from '../lib/managed-overlay-tts.js';
import {rouletteAssetOrigin} from '../lib/roulette-custom-assets.js';
import {VERCEL_AUDIO_ASSET} from '../lib/vercel-binary-assets/audio-asset.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}

async function betaLogin(id,password,requestedWorkspace){
  const url=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_SECRET_KEY||'';
  if(!url||!anon)throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY is not configured');
  const auth=await fetch(`${url}/auth/v1/token?grant_type=password`,{
    method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
    body:JSON.stringify({email:id,password}),cache:'no-store'
  });
  const data=await auth.json().catch(()=>({}));
  if(!auth.ok||!data?.user?.id)return null;
  const userId=data.user.id;
  const memberships=await sb('byeollog_workspace_members',`?select=workspace_id,role,web_session_epoch,byeollog_workspaces(id,slug,display_name,status)&user_id=eq.${encodeURIComponent(userId)}`);
  let rows=Array.isArray(memberships)?memberships.filter(x=>x?.byeollog_workspaces?.status==='active'):[];
  if(requestedWorkspace)rows=rows.filter(x=>x.workspace_id===requestedWorkspace||x.byeollog_workspaces?.slug===requestedWorkspace);
  if(!rows.length){
    const applications=await sb('byeollog_signup_applications',`?select=status,rejection_reason&auth_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`).catch(()=>[]);
    const application=Array.isArray(applications)?applications[0]:null;
    if(application?.status==='pending')return {error:'가입 신청을 확인하고 있습니다. 관리자 승인 후 이용할 수 있습니다.'};
    if(application?.status==='rejected')return {error:'가입 신청이 승인되지 않았습니다.'+(application.rejection_reason?` 사유: ${application.rejection_reason}`:'')};
    return {error:'이 계정에 연결된 별록 워크스페이스가 없습니다.'};
  }
  const m=rows[0],w=m.byeollog_workspaces;
  return {token:createSessionToken({mode:'beta',user_id:userId,email:data.user.email,workspace_id:m.workspace_id,workspace_slug:w?.slug,role:m.role,session_epoch:m.web_session_epoch}),workspace:w,role:m.role};
}


async function handleInquirySubmit(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  if(await isRateLimited('inquiry:ip:'+clientIp(req),{limit:8,windowMs:15*60*1000}))return res.status(429).json({message:'문의 전송 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  const b=bodyOf(req);
  const contact=String(b.contact||'').trim();
  const message=String(b.message||'').trim();
  if(contact.length<2||contact.length>120)return res.status(400).json({message:'디스코드 ID를 입력해주세요.'});
  if(message.length<5||message.length>2000)return res.status(400).json({message:'문의 내용을 5자 이상 입력해주세요.'});
  const ip=clientIp(req);
  const ipHash=ip?crypto.createHash('sha256').update(ip).digest('hex').slice(0,32):null;
  const ua=String(req.headers['user-agent']||'').slice(0,240)||null;
  try{
    await sb('byeollog_inquiries','',{
      method:'POST',
      body:{contact,message,status:'archived',ip_hash:ipHash,user_agent:ua}
    });
    return res.status(200).json({ok:true,message:'문의가 접수되었습니다. 확인 후 연락드리겠습니다.'});
  }catch(e){
    return res.status(500).json({
      message:'문의 접수에 실패했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
}

function bearer(req){
  const match=String(req.headers?.authorization||'').match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1]||'';
}

function managedTtsBridgeSecret(){
  const secret=String(process.env.BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET||'').trim();
  if(secret.length<43||secret.length>200||!/^[A-Za-z0-9._~-]+$/.test(secret))return '';
  return secret;
}

function pcm16MonoWav(pcm,sampleRate){
  const audio=Buffer.from(pcm),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+audio.length,4);header.write('WAVE',8);
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);
  header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);
  header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(audio.length,40);
  return Buffer.concat([header,audio]);
}

async function handleInternalRaffleTts(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const secret=managedTtsBridgeSecret();
  if(!secret)return res.status(503).json({message:'관리형 TTS 연결이 준비되지 않았습니다.'});
  const b=bodyOf(req);
  const workspaceId=String(b.workspaceId||'').trim().toLowerCase();
  const executionId=String(b.executionId||'').trim().toLowerCase();
  const speechKind=String(b.speechKind||'').trim();
  const bindingKey=String(b.bindingKey||'').trim().toLowerCase();
  const text=String(b.text||'').trim();
  const attemptNo=Number(b.attemptNo);
  const timestamp=String(req.headers?.['x-byeollog-timestamp']||'').trim();
  const signature=String(req.headers?.['x-byeollog-signature']||'').trim().toLowerCase();
  const timestampMs=Number(timestamp)*1000;
  if(!UUID.test(workspaceId)||!UUID.test(executionId)||!['ticket','winner'].includes(speechKind)
    ||!Number.isInteger(attemptNo)||attemptNo<1||attemptNo>10
    ||!/^[0-9a-f]{64}$/.test(bindingKey)||text.length<1||text.length>240||/[\u0000-\u001f\u007f]/.test(text)
    ||!/^\d{10}$/.test(timestamp)||!Number.isFinite(timestampMs)||Math.abs(Date.now()-timestampMs)>60_000
    ||!/^[0-9a-f]{64}$/.test(signature))return res.status(400).json({message:'관리형 TTS 요청이 올바르지 않습니다.'});
  const textHash=crypto.createHash('sha256').update(text,'utf8').digest('hex');
  const canonical=[timestamp,workspaceId,executionId,String(attemptNo),speechKind,bindingKey,textHash].join('.');
  const expected=crypto.createHmac('sha256',secret).update(canonical).digest();
  if(!crypto.timingSafeEqual(expected,Buffer.from(signature,'hex')))return res.status(401).json({message:'관리형 TTS 요청 인증에 실패했습니다.'});
  if(await isRateLimited(`raffle-managed-tts:${workspaceId}`,{limit:120,windowMs:60_000}))return res.status(429).json({message:'TTS 요청이 잠시 많습니다.'});
  try{
    const result=await managedOverlayTtsRuntime().synthesize({text,onAudioChunk:()=>{}});
    const wav=pcm16MonoWav(result.pcm,MANAGED_TTS_SAMPLE_RATE);
    const provider=result.provider==='cartesia'?'cartesia':'google';
    res.setHeader('Content-Type','audio/wav');
    res.setHeader('Content-Length',String(wav.length));
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Byeollog-Audio-Sha256',crypto.createHash('sha256').update(wav).digest('hex'));
    res.setHeader('X-Byeollog-Voice-Key',bindingKey);
    res.setHeader('X-Byeollog-Voice-Version',`managed-${provider}-v1`);
    return res.status(200).send(wav);
  }catch(error){
    console.error('[managed-raffle-tts] synthesis failed',{code:String(error?.code||'managed_tts_failed')});
    return res.status(503).json({message:'관리형 TTS 합성에 실패했습니다.',code:'raffle_tts_unavailable'});
  }
}

async function handleSoopRouletteOverlayPage(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const nonce=crypto.randomBytes(18).toString('base64url');
  let assetOrigin='';
  try{assetOrigin=rouletteAssetOrigin()}catch{}
  const assetSource=assetOrigin?` ${assetOrigin}`:'';
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; img-src 'self' data:${assetSource} https://sooplive.com https://*.sooplive.com https://afreecatv.com https://*.afreecatv.com https://afreecatvcdn.com https://*.afreecatvcdn.com; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Robots-Tag','noindex, noarchive');
  return res.status(200).send(getRouletteServiceOverlayHtml(nonce));
}

async function handleSoopWallpaperOverlayPage(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const nonce=crypto.randomBytes(18).toString('base64url');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Robots-Tag','noindex, noarchive');
  return res.status(410).send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>별록 풍벽지 · 종료됨</title><style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}</style></head><body aria-label="종료된 별록 웹 풍벽지 오버레이"></body></html>`);
}

async function handleSoopWallpaperState(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  res.setHeader('Cache-Control','no-store, private');
  // 구형 웹 OBS 클라이언트는 clientVersion이 달라지면 페이지를 새로고침한다.
  // 새 페이지는 410 투명 문서이므로 이미 떠 있던 카드까지 즉시 제거되고 폴링도 종료된다.
  return res.status(200).json({ok:false,disabled:true,reason:'moved_to_local_agent',clientVersion:'agent-only-20260831'});
}

async function handleSoopRouletteOverlayPoll(req,res){
  if(!['GET','POST'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  const payload=verifyRouletteServiceOverlayToken(bearer(req));
  if(!payload)return res.status(401).json({message:'오버레이 주소가 올바르지 않습니다.'});
  const clientId=String(req.headers?.['x-byeollog-overlay-client']||'').trim();
  if(!/^[A-Za-z0-9._:-]{8,180}$/.test(clientId))return res.status(400).json({message:'오버레이 실행 식별값이 올바르지 않습니다.'});
  try{
    if(req.method==='POST'){
      if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
      const body=bodyOf(req);
      if(body.action==='heartbeat'||body.heartbeat===true){
        const heartbeat=await touchRouletteOverlayClient(payload,clientId);
        if(heartbeat.invalid||!heartbeat.touched)return res.status(409).json({message:'오버레이가 일시정지되었거나 주소가 변경되었습니다.'});
        return res.status(200).json({ok:true});
      }
      if(body.action==='peek'){
        const eventId=String(body.eventId||'').trim().toLowerCase();
        if(!UUID.test(eventId))return res.status(400).json({message:'후원 이벤트 식별값이 올바르지 않습니다.'});
        const peeked=await peekRouletteOverlayFollowup(payload,clientId,eventId);
        if(peeked.invalid)return res.status(409).json({message:'룰렛이 일시정지되었거나 오버레이 주소가 변경되었습니다.'});
        return res.status(200).json({ok:true,peek:peeked.peek});
      }
      if(body.action==='result-revealed'){
        const commandId=String(body.commandId||'').trim().toLowerCase();
        if(!UUID.test(commandId))return res.status(400).json({message:'룰렛 결과 식별값이 올바르지 않습니다.'});
        const recorded=await recordRouletteChatDryRun(payload,clientId,commandId);
        if(recorded.invalid)return res.status(409).json({message:'룰렛이 일시정지되었거나 오버레이 주소가 변경되었습니다.'});
        return res.status(200).json({ok:true,dryRun:recorded.result});
      }
      const commandId=String(body.commandId||'').trim().toLowerCase();
      if((body.action&&body.action!=='ack')||!UUID.test(commandId)||typeof body.succeeded!=='boolean')return res.status(400).json({message:'오버레이 완료 정보가 올바르지 않습니다.'});
      const completed=await finishRouletteOverlayCommand(payload,clientId,commandId,body.succeeded,body.error);
      if(completed.invalid)return res.status(409).json({message:'룰렛이 일시정지되었거나 오버레이 주소가 변경되었습니다.'});
      return res.status(200).json({ok:true,result:completed.result});
    }
    const preferredHeader=String(req.headers?.['x-byeollog-overlay-preferred-event']||'').trim().toLowerCase();
    if(preferredHeader&&!UUID.test(preferredHeader))return res.status(400).json({message:'선호 후원 이벤트 식별값이 올바르지 않습니다.'});
    const claimed=await claimRouletteOverlayCommand(payload,clientId,{preferredEventId:preferredHeader||null});
    if(claimed.invalid)return res.status(409).json({message:'룰렛이 일시정지되었거나 오버레이 주소가 변경되었습니다.'});
    return res.status(200).json({ok:true,clientVersion:claimed.clientVersion,command:claimed.command});
  }catch(error){
    console.error('[soop-roulette-overlay] poll failed',{code:error?.code||'overlay_poll_failed'});
    if(error?.code==='55P03')return res.status(423).json({message:'다른 OBS 브라우저 소스가 이 룰렛을 사용 중입니다.'});
    if(error?.code==='55000')return res.status(409).json({message:'룰렛이 일시정지되었거나 오버레이 주소가 변경되었습니다.'});
    return res.status(503).json({message:'오버레이 이벤트를 잠시 불러오지 못했습니다.'});
  }
}

async function handleSoopRouletteOverlayTts(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const overlayPayload=verifyRouletteServiceOverlayToken(bearer(req));
  if(!overlayPayload)return res.status(401).json({message:'오버레이 주소가 올바르지 않습니다.'});
  const clientId=String(req.headers?.['x-byeollog-overlay-client']||'').trim();
  if(!/^[A-Za-z0-9._:-]{8,180}$/.test(clientId))return res.status(400).json({message:'오버레이 실행 식별값이 올바르지 않습니다.'});
  const body=bodyOf(req),text=String(body.text||'').trim(),authorization=String(body.authorization||'');
  const ttsPayload=verifyOverlayTtsAuthorization(authorization,text);
  if(!ttsPayload||ttsPayload.wid!==overlayPayload.wid||ttsPayload.cid!==clientId||ttsPayload.oid!==String(body.commandId||'').trim().toLowerCase())return res.status(403).json({message:'TTS 실행 권한이 올바르지 않습니다.'});
  let runtime;
  try{runtime=managedOverlayTtsRuntime()}catch(error){return res.status(503).json({message:'고품질 TTS를 준비하지 못했습니다.',code:String(error?.code||'managed_tts_unavailable')})}
  if(await isRateLimited(`overlay-tts:workspace:${ttsPayload.wid}`,{limit:240,windowMs:60_000}))return res.status(429).json({message:'TTS 요청이 잠시 많습니다.'});
  let claim;
  try{claim=await claimOverlayTtsSynthesis(ttsPayload)}catch(error){
    console.error('[managed-overlay-tts] claim failed',{code:error?.code||'tts_claim_failed'});
    return res.status(error?.code==='55000'?409:503).json({message:'TTS 실행 순서를 확인하지 못했습니다.'});
  }
  if(!claim?.allowed||!claim?.request_id)return res.status(409).json({message:'이미 처리했거나 처리 중인 TTS입니다.'});

  const controller=new AbortController();let responseClosed=false,firstAudioAt=null,audioBytes=0,provider='google';
  res.on?.('close',()=>{responseClosed=true;if(!res.writableEnded)controller.abort(new Error('overlay response closed'))});
  res.statusCode=200;
  res.setHeader('Content-Type',`application/x-byeollog-pcm; rate=${MANAGED_TTS_SAMPLE_RATE}; channels=1`);
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Accel-Buffering','no');
  res.setHeader('Content-Encoding','identity');
  res.flushHeaders?.();
  const startedAt=performance.now();
  try{
    const result=await runtime.synthesize({text,signal:controller.signal,onAudioChunk:(chunk,selectedProvider)=>{
      if(responseClosed)return;
      provider=selectedProvider||provider;if(firstAudioAt===null)firstAudioAt=performance.now();audioBytes+=chunk.length;
      res.write(managedTtsFrame(MANAGED_TTS_AUDIO_FRAME,chunk));
    }});
    provider=result.provider||provider;
    const metrics={succeeded:true,provider,firstAudioMs:Math.max(0,Math.round((firstAudioAt||performance.now())-startedAt)),totalMs:Math.max(0,Math.round(performance.now()-startedAt)),audioBytes};
    await finishOverlayTtsSynthesis(ttsPayload,claim.request_id,metrics).catch(error=>console.error('[managed-overlay-tts] completion record failed',{code:error?.code||'tts_completion_failed'}));
    if(!responseClosed){res.write(managedTtsFrame(MANAGED_TTS_END_FRAME));res.end()}
  }catch(error){
    provider=error?.provider==='cartesia'?'cartesia':'google';
    const errorCode=String(error?.code||'managed_tts_failed').replace(/[^a-z0-9_:-]/gi,'_').slice(0,80)||'managed_tts_failed';
    await finishOverlayTtsSynthesis(ttsPayload,claim.request_id,{succeeded:false,provider,errorCode}).catch(recordError=>console.error('[managed-overlay-tts] failure record failed',{code:recordError?.code||'tts_failure_record_failed'}));
    console.error('[managed-overlay-tts] synthesis failed',{provider,code:errorCode,partial:audioBytes>0});
    if(!responseClosed){res.write(managedTtsFrame(MANAGED_TTS_ERROR_FRAME,Buffer.from(JSON.stringify({code:errorCode,partial:audioBytes>0}),'utf8')));res.end()}
  }
}

async function handleSoopRouletteOverlaySound(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  try{
    const audio=Buffer.from(VERCEL_AUDIO_ASSET.data,'base64');
    if(audio.byteLength!==VERCEL_AUDIO_ASSET.size||crypto.createHash('sha256').update(audio).digest('hex')!==VERCEL_AUDIO_ASSET.sha256)throw new Error('roulette sound integrity mismatch');
    res.setHeader('Content-Type','audio/wav');
    res.setHeader('Content-Length',String(audio.byteLength));
    res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    return res.status(200).send(audio);
  }catch{
    return res.status(404).json({message:'Not found'});
  }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(rejectMaintenanceWrite(req,res))return;
  const operation=String(req.query?.operation||'');
  if(operation==='soop-start')return handleSoopOAuthStart(req,res);
  if(operation==='soop-callback')return handleSoopOAuthCallback(req,res);
  if(operation==='soop-status')return handleSoopOAuthStatus(req,res);
  if(operation==='soop-diagnose')return handleSoopOAuthDiagnose(req,res);
  if(operation==='soop-disconnect')return handleSoopOAuthDisconnect(req,res);
  if(operation==='soop-gateway')return handleSoopGatewayIngress(req,res);
  if(operation==='soop-roulette-overlay-page')return handleSoopRouletteOverlayPage(req,res);
  if(operation==='soop-roulette-overlay-poll')return handleSoopRouletteOverlayPoll(req,res);
  if(operation==='soop-roulette-overlay-sound')return handleSoopRouletteOverlaySound(req,res);
  if(operation==='soop-roulette-overlay-tts')return handleSoopRouletteOverlayTts(req,res);
  if(operation==='internal-raffle-tts')return handleInternalRaffleTts(req,res);
  if(operation==='soop-wallpaper-page')return handleSoopWallpaperOverlayPage(req,res);
  if(operation==='soop-wallpaper-state')return handleSoopWallpaperState(req,res);
  if(operation==='signup')return handleSignup(req,res);
  if(operation==='signup-status')return handleSignupStatus(req,res);
  if(operation==='inquiry')return handleInquirySubmit(req,res);
  if(['request-reset','confirm-reset','change'].includes(operation))return handlePassword(req,res);
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});

  // Collector 대시보드 자동 로그인 (handoff)
  if(operation==='handoff'){
    try{
      const code=String(bodyOf(req).code||'').trim();
      if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
      if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
      if(!/^[A-Za-z0-9_-]{43}$/.test(code))return res.status(400).json({message:'대시보드 로그인 코드가 올바르지 않습니다.'});
      if(await isRateLimited('handoff:ip:'+clientIp(req),{limit:30,windowMs:5*60*1000}))return res.status(429).json({message:'대시보드 로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});
      const now=new Date().toISOString();
      const codeHash=crypto.createHash('sha256').update(code).digest('hex');
      const rows=await sb(
        'byeollog_dashboard_handoffs',
        `?select=id,workspace_id,device_id,expires_at,used_at&code_hash=eq.${encodeURIComponent(codeHash)}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}&limit=1`
      );
      const handoff=Array.isArray(rows)?rows[0]:null;
      if(!handoff)return res.status(401).json({message:'대시보드 로그인 링크가 만료되었거나 이미 사용되었습니다.'});

      // M-02: used_at IS NULL 조건으로 PATCH 후 반환 행 수로 원자적 소비 확인
      const consumed=await sb(
        'byeollog_dashboard_handoffs',
        `?id=eq.${encodeURIComponent(handoff.id)}&used_at=is.null`,
        {method:'PATCH',body:{used_at:now},prefer:'return=representation'}
      );
      if(!Array.isArray(consumed)||!consumed.length){
        return res.status(401).json({message:'대시보드 로그인 링크가 만료되었거나 이미 사용되었습니다.'});
      }

      const workspaces=await sb(
        'byeollog_workspaces',
        `?select=id,slug,display_name,status&id=eq.${encodeURIComponent(handoff.workspace_id)}&status=eq.active&limit=1`
      );
      const workspace=Array.isArray(workspaces)?workspaces[0]:null;
      if(!workspace)return res.status(403).json({message:'연결된 워크스페이스를 찾을 수 없습니다.'});

      // H-01 / H-05: 기기 active 상태 재확인
      let deviceId=handoff.device_id||handoff.collector_device_id||null;
      if(!deviceId){
        return res.status(401).json({message:'연결된 Collector 기기를 확인할 수 없습니다.'});
      }
      const devices=await sb(
        'byeollog_collector_devices',
        `?select=id,workspace_id,status,created_by_user_id&id=eq.${encodeURIComponent(deviceId)}`+
        `&workspace_id=eq.${encodeURIComponent(workspace.id)}&status=eq.active&limit=1`
      ).catch(()=>[]);
      const device=Array.isArray(devices)?devices[0]:null;
      if(!device || device.workspace_id!==workspace.id || !device.created_by_user_id){
        return res.status(401).json({message:'연결된 Collector 기기가 해제되었거나 만료되었습니다.'});
      }
      deviceId=device.id;

      const memberships=await sb(
        'byeollog_workspace_members',
        `?select=role,workspace_id,web_session_epoch&user_id=eq.${encodeURIComponent(device.created_by_user_id)}`+
        `&workspace_id=eq.${encodeURIComponent(workspace.id)}&limit=1`
      ).catch(()=>[]);
      const membership=Array.isArray(memberships)?memberships[0]:null;
      if(!membership || membership.workspace_id!==workspace.id){
        return res.status(401).json({message:'Collector를 연결한 계정의 권한을 확인할 수 없습니다.'});
      }

      // 자동 로그인도 기기를 실제로 등록한 멤버의 신원과 현재 역할을 사용한다.
      // 기존 세션은 lib/auth.js의 실시간 재검증에서 같은 방식으로 보완된다.
      setSessionCookie(res,createSessionToken({
        mode:'collector_handoff',
        user_id:device.created_by_user_id,
        workspace_id:workspace.id,
        workspace_slug:workspace.slug,
        role:membership.role,
        collector_device_id:deviceId,
        session_epoch:membership.web_session_epoch,
      }));
      return res.status(200).json({ok:true,mode:'collector_handoff',workspace,role:membership.role});
    }catch(e){
      return res.status(500).json({message:'Collector 대시보드 로그인 처리에 실패했습니다.'});
    }
  }

  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const body=bodyOf(req),id=String(body.id||'').trim(),password=String(body.password||'');

  // M-01: 로그인 rate limit (IP + 계정)
  if(await isRateLimited('login:ip:'+clientIp(req), {limit:20, windowMs:10*60*1000}) ||
     (id && await isRateLimited('login:id:'+id.toLowerCase(), {limit:10, windowMs:10*60*1000}))){
    await sleep(350);
    return res.status(429).json({message:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});
  }


  try{
    const result=await betaLogin(id,password,body.workspace||'');
    if(!result){await sleep(350);return res.status(401).json({message:'이메일 또는 비밀번호가 올바르지 않습니다.'});}
    if(result.error)return res.status(403).json({message:result.error});
    setSessionCookie(res,result.token);
    return res.status(200).json({ok:true,mode:'beta',workspace:result.workspace,role:result.role});
  }catch(e){return res.status(500).json({message:'계정 로그인 처리에 실패했습니다.'});}
}
