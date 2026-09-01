import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {NATIVE_ROULETTE_ASSETS,publicNativeRouletteAsset} from '../lib/native-roulette-assets.js';

const port=Number(process.env.BYEOLLOG_PREVIEW_PORT||4173);
const customImagePath=String(process.env.BYEOLLOG_PREVIEW_CUSTOM_IMAGE||'').trim();
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  if(url.pathname==='/assets/byeollog-theme.css'){
    res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});
    return res.end(await readFile(new URL('../assets/byeollog-theme.css',import.meta.url),'utf8'));
  }
  if(url.pathname.startsWith('/assets/roulette-previews/')){
    res.writeHead(200,{'Content-Type':url.pathname.endsWith('.webp')?'image/webp':'image/png','Cache-Control':'no-store'});
    return res.end(await readFile(new URL(`../${url.pathname.slice(1)}`,import.meta.url)));
  }
  if(url.pathname==='/assets/soop-default-balloon.svg'){
    res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});
    return res.end(await readFile(new URL('../assets/soop-default-balloon.svg',import.meta.url),'utf8'));
  }
  if(url.pathname==='/assets/preview-custom'&&customImagePath){
    res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});
    return res.end(await readFile(customImagePath));
  }
  if(url.pathname==='/api/auth/soop/status')return json(res,{enabled:true,configured:true,connected:true,status:'connected',tokenStatus:'valid',chatStatus:'waiting_for_live_verification'});
  if(url.pathname==='/api/admin'){
    const operation=url.searchParams.get('operation');
    if(operation==='product-control-state')return json(res,{rules:[],rouletteDrafts:[{id:'preview-draft',rouletteName:'미리보기 룰렛',draft:{overlayAssetKey:'roulette_navy_gold_v1',...(customImagePath?{customSingleImage:{previewUrl:'/assets/preview-custom'}}:{})}}],agentDevices:[],assets:NATIVE_ROULETTE_ASSETS.map(publicNativeRouletteAsset)});
    if(operation==='context')return json(res,{streamer_name:'미리보기 스트리머'});
    if(operation==='signature-balloon-registry')return json(res,{ok:true,items:[{id:'preview-signature',balloonCount:33,displayName:'별풍선 33개',versionNumber:1,pcImage:{previewUrl:'/assets/soop-default-balloon.svg',width:195,height:145,byteSize:1545},mobileImage:{previewUrl:'/assets/soop-default-balloon.svg',width:293,height:248,byteSize:1545}}]});
    if(operation==='soop-runtime-status')return json(res,{connection:{connected:true,status:'connected'},control:{gatewayEnabled:true,nativeRouletteEnabled:true,liveDiagnosticsEnabled:true},service:{active:true,activeDraftId:'preview-draft',activeDraftVersion:1},gateway:{state:'waiting_for_live',fresh:true},observations:[]});
    return json(res,{ok:true,executionTriggered:false});
  }
  if(url.pathname==='/dashboard/roulette'||url.pathname==='/dashboard/signatures'||url.pathname==='/dashboard/overlay'||url.pathname==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(getProductDashboardHtml('preview-nonce',url.pathname==='/dashboard/signatures'?'signatures':'roulette'));
  }
  res.writeHead(404);res.end('Not found');
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`preview=http://127.0.0.1:${port}/dashboard/roulette\n`));
