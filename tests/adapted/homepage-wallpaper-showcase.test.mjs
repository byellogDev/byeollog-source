import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture,sha256} from '../../test-support/frontend/tools/Serve-HomepageWallpaperCapture.mjs';

test('homepage uses a proportional static OBS render, not reimplemented cards',async()=>{
  const html=await readFile(auditURL('../index.html',import.meta.url),'utf8');
  const stage=html.slice(html.indexOf('<div class="productStage"'),html.indexOf('<section class="section"'));
  assert.equal([...stage.matchAll(/<img /g)].length,1);
  assert.match(stage,/class="wallpaperRender"[^>]+width="960" height="540"/);
  assert.doesNotMatch(stage,/canvasGuide|1920\s*[×x]\s*1080|배치 미리보기/);
  assert.match(html,/\.wallpaperRender\{display:block;width:100%;height:auto;aspect-ratio:16\/9\}/);
  assert.doesNotMatch(stage,/actorName|actorId|workspaces\/|supabase\.co|sooplive\.com|127\.0\.0\.1|localhost|signatureCard|signatureLabel|signatureWall|<iframe/);
  assert.match(stage,/가상 닉네임 사용/);
  const capture=await readFile(auditURL('../assets/wallpaper-showcase/overlay-rendered.png',import.meta.url));
  const provenance=JSON.parse(await readFile(auditURL('./fixtures/homepage-wallpaper-capture.json',import.meta.url),'utf8'));
  assert.equal(capture.readUInt32BE(16),960);
  assert.equal(capture.readUInt32BE(20),540);
  assert.equal(sha256(capture),provenance.captureSha256);
  assert.ok(capture.length<1000000);
  assert.equal(sha256(JSON.stringify(fixture)),provenance.fixtureSha256);
  assert.equal(fixture.tiles.length,6);
  assert.deepEqual([...new Set(fixture.tiles.map(tile=>tile.actorName))].sort(),['별친구A','별친구B','별친구C']);
  for(const tile of fixture.tiles){
    assert.match(tile.id,/^example-/);
    assert.match(tile.imageUrl,/^\/assets\/wallpaper-showcase\/signature-(033|152|330)\.webp$/);
    const scale=Math.min(tile.layout.width/(2*240),tile.layout.height/(226+(tile.layout.rows-1)*46));
    const width=Math.floor(240*scale),height=Math.floor(226*scale);
    assert.equal(width,273);
    assert.equal(height,257);
    assert.equal(Math.min(21,width/13,height/12),21,'capture cards must fit the unchanged 21px label rule');
  }
  for(const amount of ['033','152','330']){
    const path=`assets/wallpaper-showcase/signature-${amount}.webp`;
    const bytes=await readFile(auditURL('../'+path,import.meta.url));
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
    assert.equal(bytes.toString('ascii',8,12),'WEBP');
    assert.ok(bytes.length<100000);
    for(let pos=12;pos+8<=bytes.length;){
      const type=bytes.toString('ascii',pos,pos+4),size=bytes.readUInt32LE(pos+4);
      assert.ok(!['EXIF','XMP '].includes(type),'no embedded identifying metadata');
      pos+=8+size+(size%2);
    }
  }
});
