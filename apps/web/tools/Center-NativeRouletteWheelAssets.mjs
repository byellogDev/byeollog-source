import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const WIDTH=1920;
const HEIGHT=1080;
const EXPECTED_FRAMES=91;
const EXPECTED_DURATION_MS=4800;
const EXPECTED_SOURCE_CENTER_Y=349;
const TARGET_CENTER_Y=HEIGHT/2;
const SHIFT_Y=TARGET_CENTER_Y-EXPECTED_SOURCE_CENTER_Y;
const ALPHA_THRESHOLD=4;

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
const sourceDirectory=resolve(workspaceRoot,'output/roulette_overlay/color_animations_wheel_only');
const outputDirectory=resolve(workspaceRoot,'output/roulette_overlay/color_animations_wheel_centered');
const previewDirectory=resolve(repositoryRoot,'assets/roulette-previews');
const only=process.argv.find(value=>value.startsWith('--only='))?.slice('--only='.length)||null;

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const duration=metadata=>(metadata.delay||[]).reduce((sum,value)=>sum+value,0);

async function alphaBounds(bytes,{animated=false}={}){
  const {data,info}=await sharp(bytes,{animated,limitInputPixels:false})
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject:true});
  let minX=info.width;
  let minY=info.height;
  let maxX=-1;
  let maxY=-1;
  for(let y=0;y<info.height;y+=1){
    for(let x=0;x<info.width;x+=1){
      if(data[(y*info.width+x)*info.channels+3]<=ALPHA_THRESHOLD)continue;
      minX=Math.min(minX,x);
      minY=Math.min(minY,y);
      maxX=Math.max(maxX,x);
      maxY=Math.max(maxY,y);
    }
  }
  if(maxX<0)throw new Error('Image has no visible pixels');
  return {minX,minY,maxX,maxY,centerY:(minY+maxY)/2};
}

function centeredPreviewPipeline(input,{shiftY}){
  return sharp(input,{limitInputPixels:false})
    .ensureAlpha()
    .extend({top:shiftY,bottom:0,left:0,right:0,background:{r:0,g:0,b:0,alpha:0}})
    .extract({left:0,top:0,width:WIDTH,height:HEIGHT});
}

function centeredAnimationPipeline(input,{shiftY}){
  // Crop and extend are multi-page aware. Applying them in this order moves
  // every frame independently instead of allowing pixels to cross a frame edge.
  return sharp(input,{animated:true,limitInputPixels:false})
    .ensureAlpha()
    .extract({left:0,top:0,width:WIDTH,height:HEIGHT-shiftY})
    .extend({top:shiftY,bottom:0,left:0,right:0,background:{r:0,g:0,b:0,alpha:0}});
}

async function centerPreview(stem){
  const pngPath=resolve(previewDirectory,`${stem}.png`);
  const webpPath=resolve(previewDirectory,`${stem}.webp`);
  const sourceBytes=await readFile(pngPath);
  const sourceBounds=await alphaBounds(sourceBytes);
  const alreadyCentered=sourceBounds.centerY===TARGET_CENTER_Y;
  if(!alreadyCentered&&sourceBounds.centerY!==EXPECTED_SOURCE_CENTER_Y){
    throw new Error(`${stem}: expected source center y=${EXPECTED_SOURCE_CENTER_Y} or ${TARGET_CENTER_Y}, received ${sourceBounds.centerY}`);
  }
  const shiftY=alreadyCentered?0:SHIFT_Y;
  const pngBytes=alreadyCentered
    ? sourceBytes
    : await centeredPreviewPipeline(sourceBytes,{shiftY}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
  const outputBounds=await alphaBounds(pngBytes);
  if(outputBounds.centerY!==TARGET_CENTER_Y){
    throw new Error(`${stem}: expected output center y=${TARGET_CENTER_Y}, received ${outputBounds.centerY}`);
  }
  const webpBytes=await sharp(pngBytes,{limitInputPixels:false})
    .webp({quality:90,alphaQuality:100,effort:6,smartSubsample:true})
    .toBuffer();
  await Promise.all([writeFile(pngPath,pngBytes),writeFile(webpPath,webpBytes)]);
  return {
    shiftY,
    bounds:outputBounds,
    previewByteSize:webpBytes.length,
    previewSha256:digest(webpBytes)
  };
}

async function centerAnimation(fileName){
  const sourcePath=resolve(sourceDirectory,fileName);
  const outputPath=resolve(outputDirectory,fileName);
  const sourceMetadata=await sharp(sourcePath,{animated:true,limitInputPixels:false}).metadata();
  if(sourceMetadata.width!==WIDTH||sourceMetadata.pageHeight!==HEIGHT||sourceMetadata.pages!==EXPECTED_FRAMES){
    throw new Error(`${fileName}: unexpected source dimensions or frame count`);
  }
  if(duration(sourceMetadata)!==EXPECTED_DURATION_MS){
    throw new Error(`${fileName}: unexpected source duration`);
  }
  const bytes=await centeredAnimationPipeline(sourcePath,{shiftY:SHIFT_Y})
    .webp({
      quality:95,
      alphaQuality:100,
      // libwebp effort 6 can coalesce the duplicate hold frame on this asset
      // set. Effort 5 keeps all 91 timing frames while remaining visually
      // indistinguishable from the reviewed source.
      effort:5,
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
  process.stdout.write(`centering ${fileName}\n`);
  const preview=await centerPreview(previewStem);
  const animation=await centerAnimation(fileName);
  manifest.push({key,fileName,...preview,shiftY:SHIFT_Y,...animation});
  process.stdout.write(`finished ${fileName} (${animation.byteSize} bytes, shiftY=${SHIFT_Y})\n`);
}

const manifestPath=resolve(outputDirectory,'manifest.json');
let previous=[];
try{previous=JSON.parse(await readFile(manifestPath,'utf8'))}catch{}
const merged=[...previous.filter(item=>!manifest.some(next=>next.key===item.key)),...manifest]
  .sort((left,right)=>left.fileName.localeCompare(right.fileName));
await writeFile(manifestPath,`${JSON.stringify(merged,null,2)}\n`);
process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`);
