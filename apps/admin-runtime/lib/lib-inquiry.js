import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';
import {isPlatformAdmin, requireSession} from './auth.js';
import {isRateLimited,clientIp} from './rate-limit.js';

function bodyOf(req){
  if(typeof req.body==='string'){
    try{return JSON.parse(req.body)}catch{return {}}
  }
  return req.body||{};
}

/** 공개 문의 접수 (인증 불필요) */
export async function handleInquirySubmit(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(await isRateLimited('inquiry:ip:'+clientIp(req),{limit:8,windowMs:15*60*1000}))return res.status(429).json({message:'문의 전송 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  const b=bodyOf(req);
  const contact=String(b.contact||'').trim();
  const message=String(b.message||'').trim();
  if(contact.length<3||contact.length>120)return res.status(400).json({message:'연락처를 올바르게 입력해주세요. (메일 또는 디스코드 ID)'});
  if(message.length<5||message.length>2000)return res.status(400).json({message:'문의 내용을 5자 이상 입력해주세요.'});
  const ip=clientIp(req);
  const ipHash=ip?crypto.createHash('sha256').update(ip).digest('hex').slice(0,32):null;
  const ua=String(req.headers['user-agent']||'').slice(0,240)||null;
  try{
    await sb('byeollog_inquiries','',{
      method:'POST',
      body:{contact,message,status:'new',ip_hash:ipHash,user_agent:ua}
    });
    return res.status(200).json({ok:true,message:'문의가 접수되었습니다. 확인 후 연락드리겠습니다.'});
  }catch(e){
    return res.status(500).json({message:'문의 접수에 실패했습니다. 잠시 후 다시 시도해주세요.'});
  }
}

/** 플랫폼 관리자 조회·상태 변경 */
export async function handleInquiryAdmin(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const session=requireSession(req,res);
  if(!session)return;
  if(!isPlatformAdmin(session))return res.status(403).json({message:'플랫폼 관리자만 사용할 수 있습니다.'});

  if(req.method==='GET'){
    try{
      const rows=await sb(
        'byeollog_inquiries',
        '?select=id,contact,message,status,created_at,read_at&order=created_at.desc&limit=100'
      );
      return res.status(200).json({ok:true,rows:Array.isArray(rows)?rows:[]});
    }catch(e){
      return res.status(500).json({message:'문의 목록을 불러오지 못했습니다.'});
    }
  }

  if(req.method==='PATCH'||req.method==='POST'){
    const b=bodyOf(req);
    const id=String(b.id||'').trim();
    const status=String(b.status||'').trim();
    if(!id)return res.status(400).json({message:'id가 필요합니다.'});
    if(!['new','read','archived'].includes(status))return res.status(400).json({message:'status가 올바르지 않습니다.'});
    try{
      const patch={status};
      if(status==='read')patch.read_at=new Date().toISOString();
      await sb('byeollog_inquiries',`?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:patch});
      return res.status(200).json({ok:true});
    }catch(e){
      return res.status(500).json({message:'상태 변경에 실패했습니다.'});
    }
  }

  return res.status(405).json({message:'Method not allowed'});
}
