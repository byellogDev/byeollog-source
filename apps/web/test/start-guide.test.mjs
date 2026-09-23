import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PUBLIC_FILES} from '../scripts/build-public-assets.mjs';

const source=path=>readFile(new URL(path,import.meta.url));
const text=async path=>(await source(path)).toString('utf8');
test('current PDF setup manual is an explicit public asset inside the setup checklist',async()=>{
  const publicPath='assets/manuals/byeollog-start-guide.pdf';
  assert.ok(PUBLIC_FILES.includes(publicPath));
  const [publicCopy,index,login,navigation,admin,vercel]=await Promise.all([
    source('../assets/manuals/byeollog-start-guide.pdf'),
    text('../index.html'),
    text('../login.html'),
    text('../lib/dashboard-navigation.js'),
    text('../lib/admin-source.html'),
    text('../vercel.json')
  ]);
  assert.ok(publicCopy.subarray(0,5).equals(Buffer.from('%PDF-')));
  for(const html of [index,login,await text('../setup.html')]){
    assert.match(html,/href=["']\/guide["']/);
    assert.match(html,/설정 매뉴얼/);
  }
  for(const html of [navigation,admin]){assert.match(html,/세팅 체크리스트/);assert.doesNotMatch(html,/href=["']\/guide["']/)}
  const config=JSON.parse(vercel);
  assert.ok(config.redirects.some(item=>item.source==='/guide'&&item.destination==='/assets/manuals/byeollog-start-guide.pdf'));
});
