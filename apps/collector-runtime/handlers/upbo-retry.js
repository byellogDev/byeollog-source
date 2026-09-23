import {timingSafeEqual} from 'node:crypto';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {runUpboRetry} from '../lib/upbo-retry.js';
import {checkUpboSchema} from '../lib/upbo-schema.js';

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const secret=process.env.BYEOLLOG_UPBO_RETRY_SECRET||process.env.CRON_SECRET||'';
  const expected=Buffer.from(`Bearer ${secret}`);
  const actual=Buffer.from(String(req.headers?.authorization||''));
  if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected))
    return res.status(401).json({message:'Unauthorized'});
  // Read-only deployment gate uses the candidate's real sensitive environment.
  if(req.query?.mode==='schema'){
    try{await checkUpboSchema();return res.status(200).json({schemaReady:true});}
    catch{return res.status(503).json({schemaReady:false});}
  }
  if(rejectMaintenanceWrite(req,res,{additionalWriteRequest:()=>true}))return;
  if(process.env.BYEOLLOG_UPBO_RETRY_ENABLED!=='true')return res.status(200).json({paused:true});
  try{return res.status(200).json(await runUpboRetry());}
  catch(error){console.error('[upbo-retry] deferred',{code:error?.code||'retry_failed'});return res.status(503).json({message:'Retry deferred'});}
}
