import crypto from 'node:crypto';
import {processPendingCollectorRows} from '../lib/collector-processor.js';
import {sb} from '../lib/supabase-rest.js';
import {
  LegacyWorkspaceConfigurationError,
  sha256,
  q,
  legacyWorkspace
} from '../lib/workspace.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {collectorSubscriptionInfo,normalizeCollectorRawPayload} from '../lib/collector-subscription.js';
import {
  legacyWeflabCollectorMode,
  legacyWeflabValidationWorkspaceAllowed
} from '../lib/core-product-scope.js';

function safeEqual(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function asBody(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}return req.body&&typeof req.body==='object'?req.body:null}
function amountOf(rec){let n=Number(rec?.value||0);try{const c=typeof rec?.currency==='string'?JSON.parse(rec.currency):rec?.currency;if(c&&c.real!==undefined&&c.real!=='')n=Number(c.real)}catch{}return Number.isFinite(n)?Math.trunc(n):0}
function boundedText(value,max){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max)}
function boundedInt(value,min,max){const n=Math.trunc(Number(value));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):null}
function safeCode(value,max=64){const text=boundedText(value,max);return /^[a-z0-9_.-]+$/i.test(text)?text:null}
function safeMessage(value){return boundedText(value,1000)
  .replace(/\bBearer\s+[^\s]+/gi,'Bearer [redacted]')
  .replace(/\bblc_[A-Za-z0-9_-]+\b/g,'[redacted-token]')
  .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[redacted-email]')}
function collectorOccurredAt(value){
  const text=boundedText(value,64);
  const local=text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(local)return `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]||'00'}+09:00`;
  const parsed=Date.parse(text);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}

async function authenticateCollectorToken(supplied){
  const expected=process.env.COLLECTOR_TOKEN||'';
  if(expected&&safeEqual(expected,supplied)){
    const legacy=await legacyWorkspace();
    return legacy?.id?{workspaceId:legacy.id,deviceId:null}:null;
  }
  if(!supplied)return null;
  try{
    const dev=await sb('byeollog_collector_devices',`?select=id,workspace_id,status,token_expires_at&token_hash=eq.${q(sha256(supplied))}&status=eq.active&limit=1`);
    if(!Array.isArray(dev)||!dev[0])return null;
    const workspaces=await sb(
      'byeollog_workspaces',
      `?select=id,status&id=eq.${q(dev[0].workspace_id)}&status=eq.active&limit=1`
    );
    if(!Array.isArray(workspaces)||workspaces[0]?.id!==dev[0].workspace_id)return null;
    const exp=dev[0].token_expires_at?Date.parse(dev[0].token_expires_at):null;
    if(exp&&exp<Date.now()){
      await sb('byeollog_collector_devices',`?id=eq.${q(dev[0].id)}`,{method:'PATCH',body:{status:'revoked',token_hash:null,revoked_at:new Date().toISOString()}}).catch(()=>{});
      return null;
    }
    return {workspaceId:dev[0].workspace_id,deviceId:dev[0].id};
  }catch{return null}
}

async function writeCollectorLog(body,workspaceId,deviceId){
  const level=safeCode(body.level,16);
  const eventType=safeCode(body.event_type,64);
  if(!['info','warning','error'].includes(level)||!['upload_success','upload_failure'].includes(eventType)){
    return {status:400,body:{message:'Invalid collector log type'}};
  }
  const occurred=boundedText(body.occurred_at_local,64);
  const occurredAt=occurred&&Number.isFinite(Date.parse(occurred))?new Date(occurred).toISOString():null;
  const now=new Date();
  const row={
    workspace_id:workspaceId,
    device_id:deviceId,
    level,
    event_type:eventType,
    occurred_at_local:occurredAt,
    collector_version:boundedText(body.collector_version,40)||null,
    session_id:boundedText(body.session_id,128)||null,
    upload_mode:safeCode(body.upload_mode,32),
    http_status:boundedInt(body.http_status,100,599),
    record_count:boundedInt(body.record_count,0,1000000),
    accepted_count:boundedInt(body.accepted_count,0,1000000),
    error_type:safeCode(body.error_type,80),
    message:safeMessage(body.message)||null,
    received_at:now.toISOString(),
    retained_until:new Date(now.getTime()+30*24*60*60*1000).toISOString()
  };
  await sb('bangsel_collector_logs','',{method:'POST',body:row});
  return {status:200,body:{ok:true}};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const collectorMode=legacyWeflabCollectorMode();
  if(collectorMode==='retired'){
    return res.status(410).json({
      message:'위플랩 Collector 수집은 SOOP Chat SDK 수집으로 전환되었습니다.',
      code:'legacy_weflab_collector_retired'
    });
  }

  const auth=String(req.headers.authorization||''),supplied=auth.startsWith('Bearer ')?auth.slice(7):'';
  let identity;
  try{
    identity=await authenticateCollectorToken(supplied);
  }catch(e){
    if(e instanceof LegacyWorkspaceConfigurationError){
      console.error('legacy Collector workspace configuration error',e.code);
      return res.status(503).json({
        message:'Legacy Collector workspace configuration is unavailable',
        code:e.code
      });
    }
    console.error('Collector authentication failed',String(e?.message||e));
    return res.status(503).json({message:'Collector authentication service unavailable',code:'collector_auth_unavailable'});
  }
  if(!identity?.workspaceId)return res.status(401).json({message:'Invalid collector token'});
  const {workspaceId,deviceId}=identity;
  if(collectorMode==='shadow'&&!legacyWeflabValidationWorkspaceAllowed(workspaceId)){
    return res.status(410).json({
      message:'위플랩 비교 수집은 지정된 검증 워크스페이스에서만 유지됩니다.',
      code:'weflab_shadow_workspace_not_allowed'
    });
  }

  const body=asBody(req);
  if(String(req.query?.operation||'').toLowerCase()==='log'){
    if(!body)return res.status(400).json({message:'JSON object required'});
    try{
      const result=await writeCollectorLog(body,workspaceId,deviceId);
      return res.status(result.status).json(result.body);
    }catch(e){
      return res.status(502).json({message:'Collector log proxy failed'});
    }
  }
  if(!body||!Array.isArray(body.records))return res.status(400).json({message:'records array required'});
  if(body.records.length>500)return res.status(413).json({message:'Too many records in one request'});

  const sessionId=String(body.session?.id||'').trim();
  if(!sessionId)return res.status(400).json({message:'session.id required'});
  const collectorVersion=String(body.collector_version||'unknown');

  const rows=[];let rejected=0;
  for(const envelope of body.records){
    const rec=envelope?.raw||envelope?.Raw||envelope;
    const cls=envelope?.classification||envelope?.Classification||{};
    const results=envelope?.rouletteResults||envelope?.RouletteResults||[];
    const fixedRewards=envelope?.fixedRewards||envelope?.FixedRewards||[];
    const subscription=collectorSubscriptionInfo(rec);
    const uid=String(rec?.uid||'').trim();
    if(!uid){rejected++;continue}
    rows.push({
      source_uid:uid,session_id:sessionId,workspace_id:workspaceId,
      broadcast_start_local:body.session?.start_local||null,broadcast_end_local:body.session?.end_local||null,
      donated_time_text:String(rec?.create_time||rec?.time||''),nickname:String(rec?.name||''),soop_id:String(rec?.id||rec?.bjid||''),
      balloons:subscription.isSubscription?0:amountOf(rec),roulette:subscription.isSubscription?'':String(rec?.roulette||''),
      event_name:subscription.isSubscription?null:(cls?.eventName??cls?.EventName??null),expected_spins:subscription.isSubscription?0:(cls?.expectedSpins??cls?.ExpectedSpins??null),
      actual_spins:subscription.isSubscription?0:Number(cls?.actualSpins??cls?.ActualSpins??results.length??0),validation:subscription.isSubscription?'subscription':String(cls?.validation??cls?.Validation??'unmapped'),
      roulette_results:subscription.isSubscription?[]:(Array.isArray(results)?results:[]),fixed_rewards:subscription.isSubscription?[]:(Array.isArray(fixedRewards)?fixedRewards.map(x=>({event_name:String(x?.eventName??x?.EventName??''),upbo_type:String(x?.upboType??x?.UpboType??''),quantity:Math.max(1,Math.trunc(Number(x?.quantity??x?.Quantity??1)||1))})).filter(x=>x.event_name&&x.upbo_type):[]),collector_version:collectorVersion,raw_payload:normalizeCollectorRawPayload(rec),uploaded_at:new Date().toISOString()
    });
  }
  if(!rows.length)return res.status(200).json({ok:true,accepted:0,rejected});

  const supabaseUrl=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),secretKey=process.env.SUPABASE_SECRET_KEY||'',serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!supabaseUrl||!secretKey||!serviceRoleKey)return res.status(500).json({message:'Supabase server environment variables are not configured'});

  try{
    if(collectorMode==='shadow'){
      const observedAt=new Date().toISOString();
      const validationRows=rows.map(row=>({
        workspace_id:workspaceId,
        source_uid:boundedText(row.source_uid,240),
        session_id:boundedText(row.session_id,200),
        donated_time_text:boundedText(row.donated_time_text,64)||null,
        donated_at:collectorOccurredAt(row.donated_time_text),
        actor_id:boundedText(row.soop_id,180)||null,
        actor_name:boundedText(row.nickname,120)||null,
        amount:Math.max(0,Math.trunc(Number(row.balloons)||0)),
        roulette_name:boundedText(row.event_name,160)||null,
        expected_spins:row.expected_spins!==null&&row.expected_spins!==undefined&&Number.isSafeInteger(Number(row.expected_spins))
          ?Number(row.expected_spins):null,
        actual_spins:Math.max(0,Math.trunc(Number(row.actual_spins)||0)),
        source_validation:boundedText(row.validation,40)||'unmapped',
        roulette_results:Array.isArray(row.roulette_results)?row.roulette_results:[],
        collector_version:boundedText(row.collector_version,40)||null,
        observed_at:observedAt,
        updated_at:observedAt
      }));
      const upstream=await fetch(`${supabaseUrl}/rest/v1/byeollog_weflab_shadow_events?on_conflict=workspace_id,source_uid`,{
        method:'POST',
        headers:{apikey:secretKey,Authorization:'Bearer '+serviceRoleKey,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},
        body:JSON.stringify(validationRows),cache:'no-store'
      });
      const text=await upstream.text();
      if(!upstream.ok)return res.status(502).json({message:'Weflab shadow validation save failed',detail:text.slice(0,1000)});
      let saved=validationRows.length;try{const parsed=JSON.parse(text);if(Array.isArray(parsed))saved=parsed.length}catch{}
      if(deviceId){
        await sb('byeollog_collector_devices',`?id=eq.${q(deviceId)}`,{
          method:'PATCH',body:{last_seen_at:observedAt,last_upload_at:observedAt,collector_version:collectorVersion}
        }).catch(()=>{});
      }
      return res.status(200).json({
        ok:true,accepted:saved,rejected,session_id:sessionId,workspace_id:workspaceId,
        automation:{ok:true,mode:'shadow_validation',processed:0}
      });
    }

    const activeRows=rows.map(row=>({...row,source_scope:'soop'}));
    const upstream=await fetch(`${supabaseUrl}/rest/v1/bangsel_collector_staging?on_conflict=workspace_id,source_scope,source_uid`,{
      method:'POST',
      headers:{apikey:secretKey,Authorization:'Bearer '+serviceRoleKey,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},
      body:JSON.stringify(activeRows),cache:'no-store'
    });
    const text=await upstream.text();
    if(!upstream.ok)return res.status(502).json({message:'Collector staging upsert failed',detail:text.slice(0,1000)});
    let saved=rows.length;try{const parsed=JSON.parse(text);if(Array.isArray(parsed))saved=parsed.length}catch{}

    // 업로드 성공과 자동처리 성공은 분리한다. staging 저장이 끝났다면 Collector에는 성공으로 응답하고,
    // 서버 자동처리 실패는 staging의 failed 상태/응답 요약으로 남겨 데이터 재전송 폭주를 막는다.
    let automation=null;
    try{
      automation=await processPendingCollectorRows({sourceUids:rows.map(r=>r.source_uid),includeFailed:false,workspaceId});
    }catch(e){
      automation={ok:false,error:String(e?.message||e)};
    }

    if(deviceId){
      const now=new Date().toISOString();
      await sb('byeollog_collector_devices',`?id=eq.${q(deviceId)}`,{method:'PATCH',body:{last_seen_at:now,last_upload_at:now,collector_version:collectorVersion}}).catch(()=>{});
    }
    return res.status(200).json({ok:true,accepted:saved,rejected,session_id:sessionId,workspace_id:workspaceId,automation});
  }catch(e){
    return res.status(502).json({message:'Collector proxy failed'});
  }
}
