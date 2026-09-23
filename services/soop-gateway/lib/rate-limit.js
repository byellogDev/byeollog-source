import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';

function hashKey(key){
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** 운영 DB의 원자적 fixed-window 카운터. 원문 IP·이메일은 저장하지 않는다. */
export async function takeRateLimit(key,{limit=10,windowMs=10*60*1000}={}){
  const rows=await sb('rpc/byeollog_take_rate_limit','',{
    method:'POST',
    body:{
      p_key_hash:hashKey(key),
      p_limit:Math.max(1,Math.min(1000,Math.trunc(Number(limit)||10))),
      p_window_seconds:Math.max(1,Math.min(86400,Math.ceil((Number(windowMs)||600000)/1000)))
    }
  });
  const row=Array.isArray(rows)?rows[0]:rows;
  if(!row||typeof row.limited!=='boolean')throw new Error('Rate limit service returned an invalid response');
  return {limited:row.limited,currentHits:Number(row.current_hits)||0,retryAfterSeconds:Number(row.retry_after_seconds)||0};
}

export async function isRateLimited(key,options){return (await takeRateLimit(key,options)).limited}

export function clientIp(req){
  return String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
}
