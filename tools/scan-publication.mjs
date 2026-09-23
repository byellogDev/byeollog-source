import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const ignored=new Set(['.git','.vercel','node_modules','public-dist','bin','obj','.local','test-results']);
function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>{if(ignored.has(e.name))return [];const f=path.join(p,e.name);return e.isDirectory()?walk(f):[path.relative(root,f).replaceAll('\\','/')];});}
const files=process.argv.includes('--tracked')?execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean):walk(root);
const patterns=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],['supabase-secret',/\bsb_secret_[A-Za-z0-9_-]{20,}\b/],['aws-access',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],['credential-url',/\b(?:postgres(?:ql)?|mysql):\/\/[^\s:'"/]+:[^\s@'"/]+@[^\s'"/]+/],['signed-jwt',/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/]];
const findings=[];
for(const f of files){
 if(/(?:^|\/)(?:\.env(?:\.|$)|auth\.json$|worker-state\.json$)|\.(?:pem|pfx|p12|dpapi|protected|sqlite|db|zip|exe|msi)$/i.test(f)&&!f.endsWith('/.env.gateway.example'))findings.push({file:f,rule:'forbidden-file'});
 const b=fs.readFileSync(path.join(root,f));if(b.includes(0))continue;
 const s=b.toString('utf8');for(const [rule,re]of patterns)if(re.test(s))findings.push({file:f,rule});
}
console.log(JSON.stringify({files:files.length,findings},null,2));
if(findings.length)process.exitCode=1;
