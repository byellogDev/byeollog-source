import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const owners={'frontend':'apps/web','admin-runtime':'apps/admin-runtime','collector-runtime':'apps/collector-runtime','public-runtime':'apps/public-runtime','backup-worker':'apps/backup-worker','ncp-gateway':'services/soop-gateway'};
const endpointOwner={admin:'admin-runtime',login:'admin-runtime',data:'admin-runtime',backups:'admin-runtime',restore:'admin-runtime',logout:'admin-runtime','collector-process':'admin-runtime','roulette-void':'admin-runtime',collector:'collector-runtime','collector-pair':'collector-runtime','upbo-retry':'collector-runtime'};
const base=owner=>path.join(root,owners[owner]);
function resolve(suffix,owner){
 if(!suffix)return base('frontend')+path.sep;
 if(suffix==='vercel.json'||suffix==='.vercelignore'||suffix.startsWith('supabase/')||suffix.startsWith('scripts/'))owner='frontend';
 if(suffix.startsWith('services/'))owner='ncp-gateway';
 if(suffix.startsWith('api/')){owner=endpointOwner[suffix.slice(4).replace(/\.js$/,'')]||owner;const h=path.join(base(owner),suffix.replace(/^api\//,'handlers/'));if(fs.existsSync(h))return h;}
 const direct=path.join(base(owner),suffix);if(fs.existsSync(direct))return direct;
 if(suffix.startsWith('lib/'))for(const other of ['admin-runtime','collector-runtime','public-runtime','ncp-gateway']){const f=path.join(base(other),suffix);if(fs.existsSync(f))return f;}
 const front=path.join(base('frontend'),suffix);if(fs.existsSync(front))return front;
 const support=path.join(root,'test-support/frontend',suffix);return fs.existsSync(support)?support:front;
}
export function auditURL(value,parent,owner){
 const url=new URL(value,parent);if(url.protocol!=='file:')return url;
 const p=fileURLToPath(url),marker=path.sep+'BYEOLLOG_AGENT_DEV_v07022';
 if(p.includes(marker))return pathToFileURL(path.join(root,'apps/windows-agent',p.slice(p.indexOf(marker)+marker.length).replace(/^[/\\]+/,''))+(url.pathname.endsWith('/')?path.sep:''));
 const adapted=path.join(root,'tests/adapted');
 if(!fs.existsSync(p)&&p.startsWith(adapted+path.sep))return pathToFileURL(resolve('test/'+path.relative(adapted,p).replaceAll('\\','/'),owner));
 if(!fs.existsSync(p)&&p.includes(path.sep+'.github'+path.sep))return pathToFileURL(path.join(root,'test-support/.github',p.split(path.sep+'.github'+path.sep)[1]));
 if(p.startsWith(base('frontend')+path.sep))return pathToFileURL(resolve(path.relative(base('frontend'),p).replaceAll('\\','/'),owner));
 const tests=path.join(root,'tests');
 if(p===tests||p===tests+path.sep)return pathToFileURL(resolve('',owner));
 if(p.startsWith(tests+path.sep)&&!p.includes(path.sep+'adapted'+path.sep))return pathToFileURL(resolve(path.relative(tests,p).replaceAll('\\','/'),owner));
 return url;
}
