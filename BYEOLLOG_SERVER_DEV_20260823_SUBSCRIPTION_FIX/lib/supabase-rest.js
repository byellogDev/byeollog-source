export function supabaseConfig(){
  const url=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const apikey=process.env.SUPABASE_SECRET_KEY||'';
  const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!url||!apikey||!serviceRoleKey) throw new Error('Supabase server environment variables are not configured');
  return {url,apikey,serviceRoleKey};
}

export async function sb(table,path='',opt={}){
  const {url,apikey,serviceRoleKey}=supabaseConfig();
  const method=(opt.method||'GET').toUpperCase();
  const headers={
    apikey,
    Authorization:'Bearer '+serviceRoleKey,
    'Content-Type':'application/json',
    Prefer:opt.prefer||'return=representation'
  };
  let body;
  if(opt.body!==undefined) body=typeof opt.body==='string'?opt.body:JSON.stringify(opt.body);
  const res=await fetch(`${url}/rest/v1/${table}${path}`,{method,headers,body,cache:'no-store',signal:opt.signal});
  const text=await res.text();
  let data=null;
  try{data=text?JSON.parse(text):null}catch{data=text}
  if(!res.ok){
    const err=new Error((data&&data.message)||String(data)||`Supabase HTTP ${res.status}`);
    err.status=res.status; err.detail=data; throw err;
  }
  return data;
}
