import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getCommonOverlayV8Html} from '../lib/common-overlay-v8.js';
import {NATIVE_ROULETTE_ASSET_BY_KEY,nativeRouletteAssetPublicUrl} from '../lib/native-roulette-assets.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const assets=Object.fromEntries(Object.values(NATIVE_ROULETTE_ASSET_BY_KEY).map(asset=>[
  asset.key,{previewUrl:asset.previewUrl,animationUrl:nativeRouletteAssetPublicUrl(asset),colors:asset.swatch,widthPx:asset.widthPx,heightPx:asset.heightPx}
]));
const port=Math.max(1024,Math.min(65535,Number(process.argv[2])||4187));
const previewSingleImage=String(process.env.BYEOLLOG_OVERLAY_PREVIEW_SINGLE_IMAGE||'').trim();
const previewSeriesImage=String(process.env.BYEOLLOG_OVERLAY_PREVIEW_SERIES_IMAGE||previewSingleImage).trim();

function fixtureScript(){
  return `
void (async()=>{
const demoCase=new URLSearchParams(location.search).get('case')||'single';
const basePayload={eventId:'514ff4e5-dcc3-4541-887c-f9b18eecaf59',eventOccurredAt:new Date().toISOString(),actor:{name:'별빛테스터'},amount:330,donationTypeLabel:'별풍선',resultText:'행운 보너스',rouletteItems:['행운 보너스','윙크','뽀뽀','사랑해','아봉 10초'],overlayAssetKey:'roulette_navy_gold_v1',spinIndex:0,spinCount:1};
if(demoCase==='donation152'){
  basePayload.actor.name='후원 테스트';basePayload.amount=152;basePayload.ceremony={source:'soop_default',url:'https://res.sooplive.com/new_player/items/ba_step4.png',providerFallbackUrl:null,defaultFallbackUrl:null};
  const ceremonyCommand={id:'5d66048f-d838-4efc-b2b1-6123d37c3468',kind:'donation_ceremony',payload:basePayload};
  await ceremony(ceremonyCommand);clearCeremonyCloseTimer();await sleep(180);showCeremonyMessage('오늘도 응원합니다!');await sleep(700);
  document.documentElement.dataset.previewOpenCount='1';document.documentElement.dataset.previewReady='true';return;
}
if(demoCase==='signature'){
  basePayload.amount=100;basePayload.ceremony={source:'signature',url:'/assets/roulette-previews/roulette-01-navy-gold.png',providerFallbackUrl:null};
  const ceremonyCommand={id:'7d66048f-d838-4efc-b2b1-6123d37c3468',kind:'donation_ceremony',payload:basePayload};
  await ceremony(ceremonyCommand);await sleep(180);
  showCeremonyMessage('시그니처풍 이미지와 후원 정보, 후원 멘트가 한 화면에 유지되는지 확인하는 백이십 자 이내 방송용 테스트 문장입니다. 티티에스가 끝날 때까지 이 카드가 사라지지 않습니다.');
  await sleep(700);
  document.documentElement.dataset.previewOpenCount='1';document.documentElement.dataset.previewReady='true';return;
}
if(demoCase==='ordinary-no-image'){
  basePayload.actor.name='후원테스트';basePayload.amount=99;basePayload.ceremony={source:'none',url:null,providerFallbackUrl:null,defaultFallbackUrl:null};
  const ceremonyCommand={id:'6d66048f-d838-4efc-b2b1-6123d37c3468',kind:'donation_ceremony',payload:basePayload};
  await ceremony(ceremonyCommand);await sleep(180);
  showCeremonyMessage('공식 이미지를 불러오지 못해도 후원 정보와 메시지는 정상적으로 표시됩니다.');
  document.documentElement.dataset.previewOpenCount='1';document.documentElement.dataset.previewReady='true';return;
}
if(demoCase==='series'){basePayload.spinIndex=5;basePayload.spinCount=11;basePayload.donationTypeLabel='도전미션'}
if(demoCase==='long'){basePayload.actor.name='가나다라마바사아자차카타';basePayload.amount=123456789;basePayload.resultText='가나다라마바사아자차카타파하거너더러머버';basePayload.spinCount=11;basePayload.spinIndex=10}
const previewImage=demoCase==='series'?${JSON.stringify(previewSeriesImage)}:${JSON.stringify(previewSingleImage)};
if(previewImage)basePayload.customImage={previewUrl:previewImage};
const demo={id:'8d66048f-d838-4efc-b2b1-6123d37c3468',kind:'roulette_spin',payload:basePayload};
await openRoulette(demo);await sleep(540);
const positions=[];
if(demoCase==='series'){
  for(let index=0;index<11;index++){
    basePayload.spinIndex=index;basePayload.presentationIndex=index;basePayload.presentationCount=11;
    setMeta(basePayload);setSeriesCounter(basePayload);startSlot(basePayload.rouletteItems);await sleep(80);stopSlot();setWinner(basePayload.resultText);
    if(index===5)showMessage('눈치챙겨');
    await sleep(90);const rect=document.getElementById('rouletteCard').getBoundingClientRect();positions.push({x:rect.x,y:rect.y,width:rect.width});
  }
}else{
  startSlot(basePayload.rouletteItems);await sleep(720);stopSlot();setWinner(basePayload.resultText);
  if(demoCase==='long')showMessage('가나다라마바사아자차카타파하 이것은 숲 채팅 제한에 맞춘 백이십 자 후원 멘트가 카드 아래에서 단 한 글자도 잘리지 않고 여러 줄로 안전하게 보이는지 확인하기 위한 실제 방송용 긴 문장 테스트입니다. 끝까지 보입니다.');
}
await sleep(900);
document.documentElement.dataset.previewOpenCount='1';
document.documentElement.dataset.previewSeriesFrames=String(positions.length);
document.documentElement.dataset.previewPositionStable=String(positions.every(item=>Math.abs(item.x-positions[0].x)<.5&&Math.abs(item.y-positions[0].y)<.5&&Math.abs(item.width-positions[0].width)<.5));
document.documentElement.dataset.previewReady='true';
})();
`;
}

function previewHtml(){
  const html=getCommonOverlayV8Html('preview-nonce',{assets,clientVersion:'common-overlay-v8-preview'});
  return html.replace('\npoll();\n',`\n${fixtureScript()}\n`);
}

function typeFor(pathname){
  const extension=extname(pathname).toLowerCase();
  return ({'.png':'image/png','.webp':'image/webp','.gif':'image/gif','.jpg':'image/jpeg','.jpeg':'image/jpeg','.wav':'audio/wav'})[extension]||'application/octet-stream';
}

createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'127.0.0.1'}`);
  if(url.pathname==='/'){
    const body=Buffer.from(previewHtml());
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':String(body.length),'Cache-Control':'no-store'});
    res.end(body);return;
  }
  const target=resolve(root,'.'+decodeURIComponent(url.pathname));
  if(!target.startsWith(root+sep)){res.writeHead(403);res.end();return}
  try{
    const body=await readFile(target);
    res.writeHead(200,{'Content-Type':typeFor(target),'Content-Length':String(body.length),'Cache-Control':'no-store'});
    res.end(body);
  }catch{res.writeHead(404);res.end()}
}).listen(port,'127.0.0.1',()=>console.log(`Common overlay v8 preview: http://127.0.0.1:${port}`));
