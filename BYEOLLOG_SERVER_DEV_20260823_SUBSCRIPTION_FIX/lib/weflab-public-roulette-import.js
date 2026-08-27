import crypto from 'node:crypto';

const PUBLIC_URL=/^\/user\/([A-Za-z0-9_-]{6,80})$/;
const MAX_HTML_BYTES=2*1024*1024;
const MAX_GROUPS=50;
const MAX_ITEMS=200;

export class WeflabPublicImportError extends Error{
  constructor(message,code='weflab_import_invalid',status=400){
    super(message);this.name='WeflabPublicImportError';this.code=code;this.status=status;
  }
}

function decode(value){
  return String(value??'')
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&')
    .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16)));
}

function attr(tag,name){
  const match=String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i'));
  return decode(match?.[1]??match?.[2]??'').trim();
}

function classValue(block,className){
  const expression=new RegExp(`<[^>]+class=(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>`,'i');
  const tag=String(block).match(expression)?.[0]||'';
  return attr(tag,'value');
}

function probabilityToPpm(value){
  const match=String(value).trim().match(/^(\d{1,3})(?:\.(\d{1,4}))?$/);
  if(!match)throw new WeflabPublicImportError('공개 페이지에 올바르지 않은 확률이 있습니다.','weflab_probability_invalid',422);
  const ppm=Number(match[1])*10000+Number(String(match[2]||'').padEnd(4,'0'));
  if(ppm<1||ppm>1000000)throw new WeflabPublicImportError('공개 페이지 확률 범위를 확인해주세요.','weflab_probability_invalid',422);
  return ppm;
}

export function normalizeWeflabPublicUrl(input){
  let url;
  try{url=new URL(String(input||'').trim())}catch{throw new WeflabPublicImportError('위플랩 공개 룰렛 주소를 확인해주세요.','weflab_url_invalid')}
  if(url.protocol!=='https:'||url.hostname!=='weflab.com'||url.port||url.username||url.password||url.search||url.hash||!PUBLIC_URL.test(url.pathname)){
    throw new WeflabPublicImportError('https://weflab.com/user/... 형식의 공개 주소만 가져올 수 있습니다.','weflab_url_invalid');
  }
  return url.href;
}

export function parseWeflabPublicRouletteHtml(html,{sourceUrl=''}={}){
  const source=String(html||'');
  if(!source||Buffer.byteLength(source,'utf8')>MAX_HTML_BYTES){
    throw new WeflabPublicImportError('공개 페이지 응답 크기가 올바르지 않습니다.','weflab_response_size',422);
  }
  if(!/name=["']item_roulette_donation["']/i.test(source)||!/input_roulette_percent/i.test(source)){
    throw new WeflabPublicImportError('해당 공개 페이지에서 룰렛 확률표를 찾지 못했습니다.','weflab_roulette_not_found',422);
  }
  const rootStart=source.search(/<div\s+id=["']setup_alert_list["'][^>]*name=["']item_roulette_donation["'][^>]*>/i);
  if(rootStart<0)throw new WeflabPublicImportError('공개 룰렛 묶음을 찾지 못했습니다.','weflab_group_count',422);
  const root=source.slice(rootStart);
  // One public page wraps all amount tiers in a single setup_alert_list. Each
  // alert_box is one independently configured roulette and must receive its
  // own new Byeollog name during import.
  const starts=[...root.matchAll(/<div[^>]*class=["'][^"']*\balert_box\b[^"']*\bsub_content_box\b[^"']*["'][^>]*>/gi)].map(match=>match.index);
  if(!starts.length||starts.length>MAX_GROUPS)throw new WeflabPublicImportError('공개 룰렛 묶음 수를 확인해주세요.','weflab_group_count',422);
  const groups=[];
  for(let index=0;index<starts.length;index++){
    const block=root.slice(starts[index],starts[index+1]??root.length);
    const amountMatch=block.match(/class=["'][^"']*\bvalue\s+min\b[^"']*["'][^>]*>\s*([0-9,]+)\s*</i);
    const balloonsPerSpin=Number(String(amountMatch?.[1]||'').replace(/,/g,''));
    if(!Number.isSafeInteger(balloonsPerSpin)||balloonsPerSpin<1||balloonsPerSpin>1000000){
      throw new WeflabPublicImportError('공개 페이지의 후원 개수를 확인해주세요.','weflab_amount_invalid',422);
    }
    const itemBlocks=[...block.matchAll(/<div[^>]*class=["'][^"']*\broulette_box\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].map(match=>match[1]);
    if(itemBlocks.length<2||itemBlocks.length>MAX_ITEMS){
      throw new WeflabPublicImportError('각 룰렛은 상품이 2개 이상 200개 이하여야 합니다.','weflab_item_count',422);
    }
    const seen=new Set();let total=0;
    const items=itemBlocks.map((itemBlock,itemIndex)=>{
      const resultText=classValue(itemBlock,'input_roulette_name');
      const type=classValue(itemBlock,'select_roulette_type')||'텍스트';
      const probabilityPpm=probabilityToPpm(classValue(itemBlock,'input_roulette_percent'));
      if(!resultText||resultText.length>200)throw new WeflabPublicImportError(`${itemIndex+1}번 상품명을 확인해주세요.`,'weflab_item_invalid',422);
      const identity=resultText.toLocaleLowerCase('ko-KR');
      if(seen.has(identity))throw new WeflabPublicImportError('같은 상품명이 중복되어 있습니다.','weflab_item_duplicate',422);
      seen.add(identity);total+=probabilityPpm;
      return {resultText,probabilityPpm,sourceType:type,directUpbo:false,ttsText:`${resultText}, 당첨!`};
    });
    if(total!==1000000)throw new WeflabPublicImportError(`별풍선 ${balloonsPerSpin}개 룰렛의 확률 합계가 100%가 아닙니다.`,'weflab_probability_total',422);
    groups.push({sourceIndex:index,balloonsPerSpin,items});
  }
  const normalized=JSON.stringify(groups.map(group=>({balloonsPerSpin:group.balloonsPerSpin,items:group.items.map(item=>[item.resultText,item.probabilityPpm,item.sourceType])})));
  return {sourceUrl:sourceUrl?normalizeWeflabPublicUrl(sourceUrl):null,sourceFingerprint:crypto.createHash('sha256').update(normalized).digest('hex'),groups};
}

export async function fetchWeflabPublicRoulette(input,{fetchImpl=fetch}={}){
  const sourceUrl=normalizeWeflabPublicUrl(input);
  let current=sourceUrl;
  for(let hop=0;hop<2;hop++){
    const response=await fetchImpl(current,{headers:{Accept:'text/html','User-Agent':'BYEOLLOG-Public-Roulette-Importer/1.0'},redirect:'manual',signal:AbortSignal.timeout(8000)});
    if([301,302,303,307,308].includes(response.status)){
      const next=normalizeWeflabPublicUrl(new URL(response.headers.get('location')||'',current).href);
      if(next===current)throw new WeflabPublicImportError('공개 주소가 반복 이동합니다.','weflab_redirect_loop',422);
      current=next;continue;
    }
    if(!response.ok)throw new WeflabPublicImportError(`공개 페이지를 불러오지 못했습니다. (${response.status})`,'weflab_fetch_failed',422);
    const contentType=String(response.headers.get('content-type')||'').toLowerCase();
    if(!contentType.includes('text/html'))throw new WeflabPublicImportError('공개 주소가 HTML 페이지가 아닙니다.','weflab_content_type',422);
    const declared=Number(response.headers.get('content-length')||0);
    if(declared>MAX_HTML_BYTES)throw new WeflabPublicImportError('공개 페이지가 너무 큽니다.','weflab_response_size',422);
    const html=await response.text();
    return parseWeflabPublicRouletteHtml(html,{sourceUrl});
  }
  throw new WeflabPublicImportError('공개 주소 이동 횟수를 초과했습니다.','weflab_redirect_limit',422);
}
