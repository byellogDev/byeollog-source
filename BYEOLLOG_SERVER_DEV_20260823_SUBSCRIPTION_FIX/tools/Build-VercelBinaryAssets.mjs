import {createHash} from 'node:crypto';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';

const sources=[
  ['roulette-spin-v1.wav','assets/audio/roulette-spin-v1.wav','audio/wav'],
  ['roulette-01-navy-gold.webp','assets/roulette-previews/roulette-01-navy-gold.webp','image/webp'],
  ['roulette-02-royal-purple-rose-gold.webp','assets/roulette-previews/roulette-02-royal-purple-rose-gold.webp','image/webp'],
  ['roulette-03-emerald-champagne.webp','assets/roulette-previews/roulette-03-emerald-champagne.webp','image/webp'],
  ['roulette-04-burgundy-pale-gold.webp','assets/roulette-previews/roulette-04-burgundy-pale-gold.webp','image/webp'],
  ['roulette-05-graphite-cyan.webp','assets/roulette-previews/roulette-05-graphite-cyan.webp','image/webp'],
  ['roulette-06-powder-blue-peach.webp','assets/roulette-previews/roulette-06-powder-blue-peach.webp','image/webp'],
  ['roulette-07-lavender-butter.webp','assets/roulette-previews/roulette-07-lavender-butter.webp','image/webp']
];

const outputDir='lib/vercel-binary-assets';
await mkdir(outputDir,{recursive:true});
await rm('lib/vercel-binary-assets.js',{force:true});

const previews=[];
for(const [index,[name,path,mimeType]] of sources.slice(1).entries()){
  const bytes=await readFile(path),data=bytes.toString('base64');
  const record=`export default Object.freeze({name:${JSON.stringify(name)},mimeType:${JSON.stringify(mimeType)},size:${bytes.length},sha256:${JSON.stringify(createHash('sha256').update(bytes).digest('hex'))},data:${JSON.stringify(data)}});\n`;
  await writeFile(`${outputDir}/preview-${index+1}.js`,record,'utf8');
  previews.push(`import preview${index+1} from './preview-${index+1}.js';`);
}
await writeFile(`${outputDir}/preview-assets.js`,`${previews.join('\n')}\nexport const VERCEL_PREVIEW_ASSETS=Object.freeze(Object.fromEntries([${sources.slice(1).map((_,index)=>`preview${index+1}`).join(',')}].map(asset=>[asset.name,asset])));\n`,'utf8');

const [audioName,audioPath,audioMimeType]=sources[0],audio=await readFile(audioPath),audioData=audio.toString('base64'),partSize=180_000;
const audioImports=[];
for(let offset=0,index=1;offset<audioData.length;offset+=partSize,index++){
  await writeFile(`${outputDir}/audio-part-${index}.js`,`export default ${JSON.stringify(audioData.slice(offset,offset+partSize))};\n`,'utf8');
  audioImports.push(`import part${index} from './audio-part-${index}.js';`);
}
await writeFile(`${outputDir}/audio-asset.js`,`${audioImports.join('\n')}\nexport const VERCEL_AUDIO_ASSET=Object.freeze({name:${JSON.stringify(audioName)},mimeType:${JSON.stringify(audioMimeType)},size:${audio.length},sha256:${JSON.stringify(createHash('sha256').update(audio).digest('hex'))},data:[${audioImports.map((_,index)=>`part${index+1}`).join(',')}].join('')});\n`,'utf8');
