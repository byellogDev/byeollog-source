const SOOP_CEREMONY_HOSTS=Object.freeze(['sooplive.com','afreecatv.com','afreecatvcdn.com']);
export const SOOP_DEFAULT_CEREMONY_BASE_URL='https://res.sooplive.com/new_player/items/';

export function normalizeSoopWallpaperImageUrl(value){
  const raw=String(value??'').trim();
  if(!raw||raw.length>2048)return null;
  try{
    const candidate=raw.startsWith('//')
      ?'https:'+raw
      :raw.startsWith('/')
        ?new URL(raw,'https://res.sooplive.com').href
        :raw.replace(/^http:\/\//i,'https://');
    const url=new URL(candidate);
    const hostname=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
    if(!SOOP_CEREMONY_HOSTS.some(root=>hostname===root||hostname.endsWith('.'+root)))return null;
    url.hash='';
    return url.href;
  }catch{return null}
}

export function soopDefaultWallpaperImageUrl(amount){
  const count=Math.max(1,Math.trunc(Number(amount)||1));
  const file=count<=50?'ba_step2.png':count<=100?'ba_step3.png':count<=500?'ba_step4.png':count<=1000?'ba_step5.png':'ba_step6.png';
  return SOOP_DEFAULT_CEREMONY_BASE_URL+file;
}
