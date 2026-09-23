import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {basename,join,relative,resolve,sep} from 'node:path';

const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const repositoryRoot=resolve(projectRoot,'..');
const output=join(projectRoot,'release-manifest.json');
const roots=['agent-updates','api','assets','installer','legal','lib','public','scripts','services','supabase/migrations','tools'];
const singleFiles=['package.json','package-lock.json','vercel.json','.vercelignore'];
const excluded=new Set(['node_modules','.vercel','.git','.soop-gateway-outbox']);

async function walk(path){
  const entries=await readdir(path,{withFileTypes:true}).catch(()=>[]),files=[];
  for(const entry of entries){
    if(excluded.has(entry.name))continue;
    const child=join(path,entry.name);
    if(entry.isDirectory())files.push(...await walk(child));
    else if(entry.isFile()&&!entry.name.toLowerCase().endsWith('.zip'))files.push(child);
  }
  return files;
}

const files=[];
// Root HTML/JS includes the public pages and the private-source middleware.
// These are release inputs too, not just files under lib/ and api/.
for(const entry of await readdir(projectRoot,{withFileTypes:true})){
  if(entry.isFile() && /\.(html|css|js)$/i.test(entry.name))files.push(join(projectRoot,entry.name));
}
for(const root of roots)files.push(...await walk(join(projectRoot,root)));
for(const file of singleFiles)files.push(join(projectRoot,file));
const normalized=[...new Set(files)].sort((a,b)=>a.localeCompare(b,'en'));
const entries=[];
for(const file of normalized){
  const bytes=await readFile(file);
  entries.push({
    path:relative(projectRoot,file).split(sep).join('/'),
    bytes:bytes.length,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

const git=(...args)=>execFileSync('git',args,{cwd:repositoryRoot,encoding:'utf8'}).trim();
const dirty=git('status','--porcelain=v1','--untracked-files=all').split(/\r?\n/).filter(Boolean)
  .filter(line=>line.includes(`${basename(projectRoot)}/`));
const sourceDigest=crypto.createHash('sha256')
  .update(entries.map(entry=>`${entry.sha256}  ${entry.path}\n`).join(''),'utf8').digest('hex');
const manifest={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  gitCommit:git('rev-parse','HEAD'),
  gitBranch:git('branch','--show-current'),
  workingTreeClean:dirty.length===0,
  dirtyPathCount:dirty.length,
  dirtyPaths:dirty.map(line=>line.slice(3).replaceAll('\\','/')).sort(),
  sourceDigest,
  fileCount:entries.length,
  files:entries
};
await writeFile(output,JSON.stringify(manifest,null,2)+'\n','utf8');
process.stdout.write(`${JSON.stringify({output,sourceDigest,fileCount:entries.length,dirtyPathCount:dirty.length})}\n`);
