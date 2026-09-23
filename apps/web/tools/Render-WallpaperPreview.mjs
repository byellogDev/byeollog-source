import path from 'node:path';
import process from 'node:process';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';

const [sourceArg, countArg='33', outputArg, nameArg='시청자예시', amountArg='100']=process.argv.slice(2);
if(!sourceArg||!outputArg){
  console.error('Usage: node tools/Render-WallpaperPreview.mjs <source> [count] <output-dir> [name] [amount]');
  process.exit(1);
}

const source=path.resolve(sourceArg);
const outputDir=path.resolve(outputArg);
const count=Math.max(1,Math.min(200,Number.parseInt(countArg,10)||33));
const donorName=String(nameArg||'시청자예시').slice(0,30);
const balloonAmount=Math.max(1,Number.parseInt(amountArg,10)||100);

const WIDTH=1920;
const HEIGHT=1080;
const TILE_WIDTH=240;
const IMAGE_HEIGHT=180;
const CARD_HEIGHT=46;
const ROW_STEP=46;
const ROWS_PER_COLUMN=20;
const LEFT=34;
const BOTTOM=22;
const COLUMN_GAP=14;

function xml(value){
  return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
}

function cardSvg(){
  return Buffer.from(`<svg width="${TILE_WIDTH}" height="${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="238" height="44" rx="7" fill="#ffffff" fill-opacity="0.97" stroke="#cbd3de" stroke-width="2"/>
    <text x="120" y="18" text-anchor="middle" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="15" font-weight="800" fill="#ea4d4d">${xml(donorName)}</text>
    <text x="120" y="38" text-anchor="middle" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="16" font-weight="800" fill="#222a35">별풍선 ${balloonAmount.toLocaleString('ko-KR')}개</text>
  </svg>`);
}

async function renderTile(image){
  return sharp({
    create:{width:TILE_WIDTH,height:IMAGE_HEIGHT+CARD_HEIGHT,channels:4,background:{r:0,g:0,b:0,alpha:0}}
  }).composite([
    {input:image,left:0,top:0},
    {input:cardSvg(),left:0,top:IMAGE_HEIGHT}
  ]).png().toBuffer();
}

await mkdir(outputDir,{recursive:true});
const sourceImage=await sharp(source,{animated:false})
  .resize(TILE_WIDTH,IMAGE_HEIGHT,{fit:'contain',position:'south',background:{r:0,g:0,b:0,alpha:0}})
  .png()
  .toBuffer();

const composites=[];
for(let index=1;index<=count;index+=1){
  const column=Math.floor((index-1)/ROWS_PER_COLUMN);
  const row=(index-1)%ROWS_PER_COLUMN;
  const cardTop=HEIGHT-BOTTOM-CARD_HEIGHT-(row*ROW_STEP);
  composites.push({
    input:await renderTile(sourceImage),
    left:LEFT+column*(TILE_WIDTH+COLUMN_GAP),
    top:cardTop-IMAGE_HEIGHT
  });
}

const overlay=await sharp({
  create:{width:WIDTH,height:HEIGHT,channels:4,background:{r:0,g:0,b:0,alpha:0}}
}).composite(composites).png().toBuffer();

const overlayPath=path.join(outputDir,`signature-wallpaper-${count}-overlay.png`);
await sharp(overlay).toFile(overlayPath);

const backdrop=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset="0.55" stop-color="#eef2f7"/><stop offset="1" stop-color="#d9e5df"/></linearGradient>
    <radialGradient id="light"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <circle cx="1320" cy="430" r="520" fill="url(#light)"/>
  <path d="M720 1080V660c135-165 310-240 525-210 203 28 365 156 490 384v246z" fill="#8ca3bb" fill-opacity="0.18"/>
  <rect x="1576" y="30" width="310" height="74" rx="22" fill="#102746" fill-opacity="0.82"/>
  <text x="1731" y="61" text-anchor="middle" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="18" font-weight="800" fill="#ffc44d">풍벽지 예상 화면</text>
  <text x="1731" y="88" text-anchor="middle" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="15" font-weight="700" fill="#ffffff">1920×1080 · ${count}건</text>
</svg>`);

const previewPath=path.join(outputDir,`signature-wallpaper-${count}-preview.png`);
await sharp(backdrop).composite([{input:overlay,left:0,top:0}]).png().toFile(previewPath);

const sourceCopyPath=path.join(outputDir,'signature-wallpaper-source-preview.png');
await sharp(source).png().toFile(sourceCopyPath);

console.log(JSON.stringify({source,sourceCopyPath,overlayPath,previewPath,count,layout:{rowsPerColumn:ROWS_PER_COLUMN,columns:Math.ceil(count/ROWS_PER_COLUMN),tileWidth:TILE_WIDTH,rowStep:ROW_STEP}},null,2));
