import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createWallpaperImageMask,normalizeWallpaperMaskImageUrl} from '../lib/wallpaper-image-mask.js';

const environment={SUPABASE_URL:'https://project.supabase.co'};

test('wallpaper hit-mask URL validation permits only SOOP and the configured Supabase origin',()=>{
  assert.equal(normalizeWallpaperMaskImageUrl('http://static.file.sooplive.com/a.png',environment),'https://static.file.sooplive.com/a.png');
  assert.equal(normalizeWallpaperMaskImageUrl('https://project.supabase.co/storage/v1/object/sign/a.png?token=secret',environment),'https://project.supabase.co/storage/v1/object/sign/a.png?token=secret');
  assert.equal(normalizeWallpaperMaskImageUrl('https://example.com/a.png',environment),null);
  assert.equal(normalizeWallpaperMaskImageUrl('https://user:pass@static.file.sooplive.com/a.png',environment),null);
});

test('wallpaper hit-mask analysis returns a compact alpha map instead of proxying the source image',async()=>{
  const source=await sharp({create:{width:4,height:4,channels:4,background:{r:255,g:0,b:0,alpha:.5}}}).png().toBuffer();
  const result=await createWallpaperImageMask('https://static.file.sooplive.com/a.png',{
    environment,
    fetchImpl:async()=>new Response(source,{status:200,headers:{'content-type':'image/png','content-length':String(source.length)}})
  });
  assert.equal(result.maskWidth,96);
  assert.equal(result.maskHeight,96);
  assert.equal(Buffer.from(result.alpha,'base64').length,96*96);
  assert.ok(result.density>.45&&result.density<.55);
  assert.equal(result.publicSoop,true);
});
