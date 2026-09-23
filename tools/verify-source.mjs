import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'source-manifest.json')));
const changes=new Map(manifest.changes.map(f=>[f.target,f.after]));
const errors=[];
const tracked=new Set(execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0'));
const missingFromGit=manifest.files.filter(f=>!tracked.has(f.path)).map(f=>f.path);
for(const f of manifest.files){const expected=changes.get(f.path)||f.sha256;const p=path.join(root,f.path);if(!fs.existsSync(p)||createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==expected)errors.push(f.path);}
console.log(JSON.stringify({files:manifest.files.length,intentionalChanges:changes.size,failed:errors.length+missingFromGit.length,errors,missingFromGit}));
if(errors.length||missingFromGit.length)process.exitCode=1;
