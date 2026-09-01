import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import sharp from 'sharp';

const outputRoot=process.argv[2]||'.tmp-vercel-inline-assets';
const images=[
  'assets/roulette-previews/roulette-01-navy-gold.png',
  'assets/roulette-previews/roulette-02-royal-purple-rose-gold.png',
  'assets/roulette-previews/roulette-03-emerald-champagne.png',
  'assets/roulette-previews/roulette-04-burgundy-pale-gold.png',
  'assets/roulette-previews/roulette-05-graphite-cyan.png',
  'assets/roulette-previews/roulette-06-powder-blue-peach.png',
  'assets/roulette-previews/roulette-07-lavender-butter.png'
];

for(const path of images){
  const outputPath=join(outputRoot,path.replace(/\.png$/i,'.webp'));
  await mkdir(dirname(outputPath),{recursive:true});
  const optimized=await sharp(path)
    .webp({quality:94,alphaQuality:100,smartSubsample:true,effort:6})
    .toBuffer();
  await writeFile(outputPath,optimized);
}

const audioPath='assets/audio/roulette-spin-v1.wav';
const audioOutput=join(outputRoot,audioPath);
if(resolve(audioOutput)!==resolve(audioPath)){
  await mkdir(dirname(audioOutput),{recursive:true});
  await writeFile(audioOutput,await readFile(audioPath));
}
