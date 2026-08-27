import {requireCapabilityLive,safeEqual} from '../lib/auth.js';
import {workspaceForSession} from '../lib/workspace.js';
import {sb} from '../lib/supabase-rest.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {getNativeRouletteSettingsHtml} from '../lib/native-roulette-settings-html.js';
import {
  NativeRouletteValidationError,
  normalizeNativeRouletteDraft,
  normalizeSoopChatEnvelope,
  normalizeSoopDonationEnvelope
} from '../lib/native-roulette.js';
import {NATIVE_ROULETTE_ASSETS,publicNativeRouletteAsset} from '../lib/native-roulette-assets.js';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bodyOf(req){
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}
  return req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
}

function servePage(res){
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return res.status(200).send(getNativeRouletteSettingsHtml());
}

async function settings(req,res){
  const session=await requireCapabilityLive(req,res,req.method==='POST'?'roulette:configure':'roulette:read');
  if(!session)return;
  const workspaceId=await workspaceForSession(session);
  if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  if(req.method==='GET'){
    try{
      const data=await sb('rpc/get_native_roulette_settings_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:session.user_id}});
      return res.status(200).json(data||{});
    }catch{
      return res.status(500).json({message:'룰렛 설정을 불러오지 못했습니다.'});
    }
  }
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(rejectMaintenanceWrite(req,res))return;
  const parsed=bodyOf(req);
  if(!parsed)return res.status(400).json({message:'Invalid JSON body'});
  try{
    const draft=normalizeNativeRouletteDraft(parsed);
    const result=await sb('rpc/save_native_roulette_draft_v1','',{
      method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:session.user_id,p_draft:draft}
    });
    return res.status(201).json(result||{ok:true,status:'cache_pending',activationAvailable:false});
  }catch(error){
    if(error instanceof NativeRouletteValidationError){
      return res.status(error.status).json({message:error.message,code:error.code});
    }
    return res.status(error?.status===409?409:500).json({message:'룰렛 초안을 저장하지 못했습니다.'});
  }
}

async function ingestSoopDonation(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(process.env.SOOP_CHAT_SDK_ENABLED!=='true'){
    return res.status(503).json({message:'SOOP Chat SDK 연동이 아직 활성화되지 않았습니다.',code:'soop_chat_sdk_disabled'});
  }
  const expected=String(process.env.SOOP_CHAT_SDK_SECRET||'');
  const supplied=String(req.headers['x-byeollog-soop-sdk-secret']||'');
  if(expected.length<32||supplied.length<32||!safeEqual(expected,supplied)){
    return res.status(401).json({message:'Unauthorized'});
  }
  if(rejectMaintenanceWrite(req,res))return;
  const parsed=bodyOf(req);
  if(!parsed)return res.status(400).json({message:'Invalid JSON body'});
  const workspaceId=String(parsed.workspaceId||'').trim().toLowerCase();
  if(!UUID_PATTERN.test(workspaceId))return res.status(400).json({message:'workspaceId is invalid'});
  try{
    const donation=normalizeSoopDonationEnvelope(parsed);
    const result=await sb('rpc/ingest_native_roulette_soop_donation_v1','',{
      method:'POST',body:{
        p_workspace_id:workspaceId,p_event_id:donation.eventId,
        p_actor_id:donation.actor.id,p_actor_name:donation.actor.name,
        p_amount:donation.amount,p_message:donation.message,p_occurred_at:donation.occurredAt
      }
    });
    return res.status(200).json(result||{});
  }catch(error){
    if(error instanceof NativeRouletteValidationError){
      return res.status(error.status).json({message:error.message,code:error.code});
    }
    if(error?.detail?.code==='55000')return res.status(409).json({message:'활성화된 별록 룰렛이 없습니다.',code:'native_roulette_inactive'});
    return res.status(500).json({message:'SOOP 룰렛 후원 처리에 실패했습니다.'});
  }
}

async function ingestSoopChat(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(process.env.SOOP_CHAT_SDK_ENABLED!=='true'){
    return res.status(503).json({message:'SOOP Chat SDK 연동이 아직 활성화되지 않았습니다.',code:'soop_chat_sdk_disabled'});
  }
  const expected=String(process.env.SOOP_CHAT_SDK_SECRET||'');
  const supplied=String(req.headers['x-byeollog-soop-sdk-secret']||'');
  if(expected.length<32||supplied.length<32||!safeEqual(expected,supplied)){
    return res.status(401).json({message:'Unauthorized'});
  }
  if(rejectMaintenanceWrite(req,res))return;
  const parsed=bodyOf(req);
  if(!parsed)return res.status(400).json({message:'Invalid JSON body'});
  const workspaceId=String(parsed.workspaceId||'').trim().toLowerCase();
  if(!UUID_PATTERN.test(workspaceId))return res.status(400).json({message:'workspaceId is invalid'});
  try{
    const chat=normalizeSoopChatEnvelope(parsed);
    const result=await sb('rpc/ingest_native_roulette_soop_chat_v1','',{
      method:'POST',body:{
        p_workspace_id:workspaceId,p_chat_event_id:chat.eventId,
        p_actor_id:chat.actor.id,p_actor_name:chat.actor.name,
        p_message:chat.message,p_occurred_at:chat.occurredAt
      }
    });
    return res.status(200).json(result||{});
  }catch(error){
    if(error instanceof NativeRouletteValidationError){
      return res.status(error.status).json({message:error.message,code:error.code});
    }
    return res.status(500).json({message:'SOOP 후원 후 첫 채팅 처리에 실패했습니다.'});
  }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(process.env.NATIVE_ROULETTE_ENABLED!=='true'){
    return res.status(404).json({message:'Not found'});
  }
  const operation=String(req.query?.operation||'').trim();
  if(req.query?.view==='settings'){
    const session=await requireCapabilityLive(req,res,'roulette:read');
    if(!session)return;
    if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
    return servePage(res);
  }
  if(operation==='assets'){
    const session=await requireCapabilityLive(req,res,'roulette:read');
    if(!session)return;
    if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
    return res.status(200).json({assets:NATIVE_ROULETTE_ASSETS.map(publicNativeRouletteAsset)});
  }
  if(operation==='settings')return settings(req,res);
  if(operation==='soop-donation')return ingestSoopDonation(req,res);
  if(operation==='soop-chat')return ingestSoopChat(req,res);
  return res.status(404).json({message:'Not found'});
}
