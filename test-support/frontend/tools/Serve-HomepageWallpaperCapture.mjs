// Offline-only capture harness. Uses the Agent's actual OBS document verbatim;
// no account cache, live donation records, server APIs, or Agent state are read.
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
export const fixture={schemaVersion:1,revision:1,canvasWidth:1920,canvasHeight:1080,tiles:[]};
for(const [amount,names,x,height,nextSide] of [
  [33,['별친구A','별친구B','별친구C'],40,362,'right'],
  [152,['별친구A','별친구B'],340,310,'right'],
  [330,['별친구C'],640,258,'right'],
]){
  names.forEach((actorName,index)=>fixture.tiles.push({
    id:`example-${amount}-${index}`,groupKey:`example-${amount}`,amount,actorName,
    displayKind:'donation',imageKey:`example-${amount}`,
    imageUrl:`/assets/wallpaper-showcase/signature-${String(amount).padStart(3,'0')}.webp`,
    layout:{x,y:460-height,width:546,height,rows:names.length,columns:2,nextSide},
  }));
}
export async function loadOverlayDocument(){
  const source=await readFile(new URL('../../BYEOLLOG_AGENT_DEV_v07022/ByeollogOverlayService.cs',import.meta.url),'utf8');
  const match=source.replace(/\r\n/g,'\n').match(/OverlayHtml = Encoding\.UTF8\.GetBytes\("""\n([\s\S]*?)\n"""\);/);
  if(!match)throw new Error('Actual Agent overlay document not found');
  return match[1];
}
export const sha256=value=>createHash('sha256').update(value).digest('hex');

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const overlay=await loadOverlayDocument();
  const assets=new Set(fixture.tiles.map(tile=>tile.imageUrl));
  assets.add('/assets/wallpaper-showcase/overlay-rendered.png');
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      res.setHeader('Cache-Control','no-store');
      if(req.method==='POST'&&url.pathname.startsWith('/overlay/')){res.writeHead(204).end();return;}
      if(req.method!=='GET'){res.writeHead(405).end();return;}
      if(url.pathname==='/overlay/wallpaper'){
        res.setHeader('Content-Type','text/html; charset=utf-8');
        // Only backdrop and a transparent screenshot locator are added. Capture a
        // 960x540 excerpt at 1:1 pixels within the unchanged 1920x1080 renderer.
        res.end(overlay.replace('</head>','<style>:root{background:#081a33}</style></head>')
          .replace('</body>','<div id="homepage-capture" aria-hidden="true" style="position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none"></div></body>'));return;
      }
      if(url.pathname==='/overlay/wallpaper-state'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture));return;
      }
      if(url.pathname==='/'){
        const config=JSON.parse(await readFile(path.join(root,'vercel.json'),'utf8'));
        const csp=config.headers.flatMap(item=>item.headers).find(item=>item.key.toLowerCase()==='content-security-policy');
        res.setHeader('Content-Security-Policy',csp.value.replace('; upgrade-insecure-requests',''));
        res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(path.join(root,'index.html')));return;
      }
      if(assets.has(url.pathname)){
        res.setHeader('Content-Type',url.pathname.endsWith('.png')?'image/png':'image/webp');
        res.end(await readFile(path.join(root,url.pathname.slice(1))));return;
      }
      res.writeHead(204).end();
    }catch(error){console.error(error.message);res.writeHead(500).end();}
  });
  server.listen(43917,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:43917/overlay/wallpaper',rendererSha256:sha256(overlay),fixtureSha256:sha256(JSON.stringify(fixture))})));
}
