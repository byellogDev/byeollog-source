import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspaceRoot=path.resolve(projectRoot,'..');
const roots=[
  projectRoot,
  path.join(workspaceRoot,'BYEOLLOG_AGENT_DEV_v07022'),
  path.join(workspaceRoot,'PROJECT_HANDOFF_20260825_NEXT_CHAT')
];
const textExtensions=new Set(['.cs','.css','.html','.js','.json','.md','.mjs','.ps1','.sql','.txt','.xml','.yml','.yaml']);
const ignoredDirectories=new Set(['.git','node_modules','output','downloads','RELEASE_v07017','RELEASE_v07018']);
const blockedIdentityHashes=new Set([
  '1c1b49155dd3afc40c09d05f738ecf8757c967f0715f5e43fc33858fefc5446a',
  '89f6be2122fce10093459400863710496cd201280042b62c7696d12e4fcd3169',
  '00d75aec0181e8190df56570f89f06f600ee8c3652d31720af451e48857ecf00',
  '0a7321526058307b885f25eb1f1c144bc8ea5b95fd6226ac5de3fd22dea8b41a',
  'cb6dc1fb55360f4b5216b6cea0a3720baefcfe9644b3e8266b36021804341ec4',
  'd37de72b8480e52f4a9ce40017459645efe1bba71ff612e51a1e0f7fcc79f7a3',
  '3d8156ae1ba3052b55327bf8555229b11783d01ea45730ef24845b7786020985',
  '2d822a905241b9c93d45f5026178378c38ff3ef776c0949a7fc9482978834935',
  'ce06d091c042f2fb5d2d2282af5080c67ededdeca9bfaa2a03bc8da349e4e614'
]);

function identityHash(value){
  return crypto.createHash('sha256').update(value.toLocaleLowerCase('en-US'),'utf8').digest('hex');
}

async function collectTextFiles(root){
  const files=[];
  async function walk(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.isDirectory()){
        if(ignoredDirectories.has(entry.name)||entry.name.startsWith('.tmp'))continue;
        await walk(path.join(directory,entry.name));
      }else if(textExtensions.has(path.extname(entry.name).toLowerCase()))files.push(path.join(directory,entry.name));
    }
  }
  await walk(root);
  return files;
}

test('active source contains no known real streamer or viewer identity examples',async()=>{
  const findings=[];
  for(const root of roots){
    for(const file of await collectTextFiles(root)){
      const source=await readFile(file,'utf8');
      for(const token of source.match(/[A-Za-z0-9_-]{3,}|[가-힣]{2,}/g)||[]){
        const digest=identityHash(token);
        if(blockedIdentityHashes.has(digest))findings.push(`${path.relative(workspaceRoot,file)}: blocked identity ${digest.slice(0,12)}`);
      }
      for(const match of source.matchAll(/https:\/\/weflab\.com\/user\/([A-Za-z0-9_-]+)/g)){
        if(match[1]!=='Abc_123-x')findings.push(`${path.relative(workspaceRoot,file)}: Weflab public id ${match[1]}`);
      }
    }
  }
  assert.deepEqual(findings,[]);
});

test('user-facing SOOP ID examples are unmistakably synthetic',async()=>{
  const dashboard=await readFile(path.join(projectRoot,'lib','admin-source.html'),'utf8');
  const examples=[...dashboard.matchAll(/placeholder="예:\s*([A-Za-z][A-Za-z0-9_]*)"/g)].map(match=>match[1]);
  assert.ok(examples.includes('viewer_example'));
  assert.equal(examples.filter(value=>value==='viewer_example').length,2);
});
