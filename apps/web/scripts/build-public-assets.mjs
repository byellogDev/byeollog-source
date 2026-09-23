import crypto from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const PUBLIC_OUTPUT_DIRECTORY='public-dist';

// Static publication is opt-in. Server source, migrations, tools, reports and
// release provenance never become public merely because they exist in the
// project directory.
export const PUBLIC_FILES=Object.freeze([
  '.well-known/security.txt',
  'agent-updates/stable/win-x64.json',
  'assets/byeollog-theme.css',
  'assets/byeollog-ui.js',
  'assets/change-password-page.js',
  'assets/login-page.js',
  'assets/reset-password-page.js',
  'assets/signup-page.js',
  'assets/signup-status-page.js',
  'assets/wallpaper-showcase/overlay-rendered.png',
  'assets/wallpaper-showcase/signature-033.webp',
  'assets/wallpaper-showcase/signature-152.webp',
  'assets/wallpaper-showcase/signature-330.webp',
  'assets/withdraw-page.js',
  'bangsel_public_workspace_isolation.html',
  'change-password.html',
  'game-link.html',
  'index.html',
  'chat-studio.html',
  'assets/chat-studio-core.css',
  'assets/chat-studio-core.js',
  'assets/chat-studio.css',
  'assets/chat-studio.js',
  'assets/chat-studio-logo.png',
  'assets/chat-studio-donation-100.png',
  'login.html',
  'assets/manuals/byeollog-start-guide.pdf',
  'privacy.html',
  'legal/previous/privacy-20260909.html',
  'legal/previous/terms-20260909.html',
  'reset-password.html',
  'signup-status.html',
  'signup.html',
  'setup.html',
  'credits.html',
  'assets/setup-page.css',
  'assets/setup-page.js',
  'assets/credits-page.js',
  'terms.html',
  'withdraw.html'
]);

function inside(root,path){
  return path===root || path.startsWith(root+sep);
}

async function walk(root,current=root){
  const entries=await readdir(current,{withFileTypes:true});
  const files=[];
  for(const entry of entries){
    const path=join(current,entry.name);
    if(entry.isDirectory())files.push(...await walk(root,path));
    else if(entry.isFile())files.push(relative(root,path).split(sep).join('/'));
    else throw new Error(`Public output contains a non-regular entry: ${relative(root,path)}`);
  }
  return files;
}

export async function buildPublicAssets({projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)))}={}){
  projectRoot=resolve(projectRoot);
  const outputRoot=resolve(projectRoot,PUBLIC_OUTPUT_DIRECTORY);
  if(!inside(projectRoot,outputRoot)||outputRoot===projectRoot)throw new Error('Invalid public output directory.');

  const manifest=JSON.parse(await readFile(join(projectRoot,'release-manifest.json'),'utf8'));
  if(!/^[a-f0-9]{64}$/.test(String(manifest.sourceDigest||'')))throw new Error('Source manifest digest is missing.');

  await rm(outputRoot,{recursive:true,force:true});
  await mkdir(outputRoot,{recursive:true});

  const hashes=[];
  for(const name of PUBLIC_FILES){
    if(name.includes('\\')||name.startsWith('/')||name.split('/').includes('..'))throw new Error(`Invalid public path: ${name}`);
    const source=resolve(projectRoot,name),target=resolve(outputRoot,name);
    if(!inside(projectRoot,source)||!inside(outputRoot,target))throw new Error(`Public path escaped its root: ${name}`);
    const stat=await lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`Public asset must be a regular file: ${name}`);
    const bytes=await readFile(source);
    hashes.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    await mkdir(dirname(target),{recursive:true});
    await copyFile(source,target);
  }

  const publicDigest=crypto.createHash('sha256').update(hashes.join(''),'utf8').digest('hex');
  const metadata={schemaVersion:1,sourceDigest:manifest.sourceDigest,publicDigest,publicFileCount:PUBLIC_FILES.length};
  await writeFile(join(outputRoot,'deployment-metadata.json'),JSON.stringify(metadata)+'\n','utf8');

  const actual=(await walk(outputRoot)).sort();
  const expected=[...PUBLIC_FILES,'deployment-metadata.json'].sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Public output differs from the explicit allowlist.');
  return {outputRoot,...metadata,files:actual};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const result=await buildPublicAssets();
    process.stdout.write(`${JSON.stringify({output:result.outputRoot,publicDigest:result.publicDigest,publicFileCount:result.publicFileCount})}\n`);
  }catch(error){
    console.error(error);
    process.exitCode=1;
  }
}
