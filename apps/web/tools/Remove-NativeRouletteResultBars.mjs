import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const WIDTH=1920;
const HEIGHT=1080;
const CLEAR_FROM_Y=720;
const EXPECTED_FRAMES=91;
const EXPECTED_DURATION_MS=4800;

const assets=[
  ['roulette_navy_gold_v1','roulette-01-navy-gold-clean-edge.webp','roulette-01-navy-gold'],
  ['roulette_royal_purple_rose_gold_v1','roulette-02-royal-purple-rose-gold-clean-edge.webp','roulette-02-royal-purple-rose-gold'],
  ['roulette_emerald_champagne_v1','roulette-03-emerald-champagne-clean-edge.webp','roulette-03-emerald-champagne'],
  ['roulette_burgundy_pale_gold_v1','roulette-04-burgundy-pale-gold-clean-edge.webp','roulette-04-burgundy-pale-gold'],
  ['roulette_graphite_cyan_v1','roulette-05-graphite-cyan-clean-edge.webp','roulette-05-graphite-cyan'],
  ['roulette_pastel_powder_blue_peach_v1','roulette-06-pastel-powder-blue-peach-clean-edge.webp','roulette-06-powder-blue-peach'],
  ['roulette_pastel_lavender_butter_v1','roulette-07-pastel-dusty-lavender-butter-clean-edge.webp','roulette-07-lavender-butter']
];

const scriptDirectory=dirname(fileURLToPath(import.meta.url));
const repositoryRoot=resolve(scriptDirectory,'..');
const workspaceRoot=resolve(repositoryRoot,'..');
const sourceDirectory=resolve(workspaceRoot,'output/roulette_overlay/color_animations_clean_edge');
const outputDirectory=resolve(workspaceRoot,'output/roulette_overlay/color_animations_wheel_only');
const previewDirectory=resolve(repositoryRoot,'assets/roulette-previews');
const only=process.argv.find(value=>value.startsWith('--only='))?.slice('--only='.length)||null;

const mask=Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${CLEAR_FROM_Y}" width="${WIDTH}" height="${HEIGHT-CLEAR_FROM_Y}" fill="#fff"/></svg>`);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const duration=metadata=>(metadata.delay||[]).reduce((sum,value)=>sum+value,0);

async function assertTransparentBelow(bytes,{animated=false,label}){
  const image=sharp(bytes,{animated,limitInputPixels:false}).ensureAlpha();
  const metadata=await image.metadata();
  const pageHeight=metadata.pageHeight||metadata.height;
  const pages=metadata.pages||1;
  const {data,info}=await image.raw().toBuffer({resolveWithObject:true});
  for(let page=0;page<pages;page+=1){
    const pageTop=page*pageHeight;
    for(let y=CLEAR_FROM_Y;y<pageHeight;y+=1){
      const row=(pageTop+y)*info.width*info.channels;
      for(let x=0;x<info.width;x+=1){
        if(data[row+x*info.channels+3]!==0){
          throw new Error(`${label}: non-transparent pixel remains below y=${CLEAR_FROM_Y} on frame ${page+1}`);
        }
      }
    }
  }
}

async function editPreview(stem){
  const pngPath=resolve(previewDirectory,`${stem}.png`);
  const webpPath=resolve(previewDirectory,`${stem}.webp`);
  const pngBytes=await sharp(pngPath,{limitInputPixels:false})
    .composite([{input:mask,blend:'dest-out'}])
    .png({compressionLevel:9,adaptiveFiltering:true})
    .toBuffer();
  await assertTransparentBelow(pngBytes,{label:`${stem}.png`});
  const webpBytes=await sharp(pngBytes,{limitInputPixels:false})
    .webp({quality:90,alphaQuality:100,effort:6,smartSubsample:true})
    .toBuffer();
  await assertTransparentBelow(webpBytes,{label:`${stem}.webp`});
  await Promise.all([writeFile(pngPath,pngBytes),writeFile(webpPath,webpBytes)]);
  return {
    previewByteSize:webpBytes.length,
    previewSha256:digest(webpBytes)
  };
}

async function editAnimation(fileName){
  const sourcePath=resolve(sourceDirectory,fileName);
  const outputPath=resolve(outputDirectory,fileName);
  const sourceMetadata=await sharp(sourcePath,{animated:true,limitInputPixels:false}).metadata();
  if(sourceMetadata.width!==WIDTH||sourceMetadata.pageHeight!==HEIGHT||sourceMetadata.pages!==EXPECTED_FRAMES){
    throw new Error(`${fileName}: unexpected source dimensions or frame count`);
  }
  if(duration(sourceMetadata)!==EXPECTED_DURATION_MS){
    throw new Error(`${fileName}: unexpected source duration`);
  }
  const bytes=await sharp(sourcePath,{animated:true,limitInputPixels:false})
    .composite([{input:mask,blend:'dest-out',tile:true}])
    .webp({
      quality:95,
      alphaQuality:100,
      effort:6,
      smartSubsample:true,
      loop:sourceMetadata.loop??0,
      delay:sourceMetadata.delay
    })
    .toBuffer();
  const outputMetadata=await sharp(bytes,{animated:true,limitInputPixels:false}).metadata();
  if(outputMetadata.width!==WIDTH||outputMetadata.pageHeight!==HEIGHT||outputMetadata.pages!==EXPECTED_FRAMES){
    throw new Error(`${fileName}: output dimensions or frame count changed`);
  }
  if(duration(outputMetadata)!==EXPECTED_DURATION_MS){
    throw new Error(`${fileName}: output duration changed`);
  }
  await assertTransparentBelow(bytes,{animated:true,label:fileName});
  await writeFile(outputPath,bytes);
  return {
    contentSha256:digest(bytes),
    byteSize:bytes.length,
    frameCount:outputMetadata.pages,
    durationMs:duration(outputMetadata)
  };
}

await mkdir(outputDirectory,{recursive:true});
const selected=only?assets.filter(([key])=>key===only):assets;
if(!selected.length)throw new Error(`Unknown --only asset key: ${only}`);

const manifest=[];
for(const [key,fileName,previewStem] of selected){
  process.stdout.write(`editing ${fileName}\n`);
  const [preview,animation]=await Promise.all([
    editPreview(previewStem),
    editAnimation(fileName)
  ]);
  manifest.push({key,fileName,...preview,...animation});
  process.stdout.write(`finished ${fileName} (${animation.byteSize} bytes)\n`);
}

const manifestPath=resolve(outputDirectory,'manifest.json');
let previous=[];
try{previous=JSON.parse(await readFile(manifestPath,'utf8'))}catch{}
const merged=[...previous.filter(item=>!manifest.some(next=>next.key===item.key)),...manifest]
  .sort((left,right)=>left.fileName.localeCompare(right.fileName));
await writeFile(manifestPath,`${JSON.stringify(merged,null,2)}\n`);
process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`);
