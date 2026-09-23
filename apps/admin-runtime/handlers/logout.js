import {clearSessionCookie} from '../lib/auth.js';

export default function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  clearSessionCookie(res);
  return res.status(200).json({ok:true});
}
