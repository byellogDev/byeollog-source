import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'source-manifest.json')));
const changes=new Map(manifest.changes.map(f=>[f.target,f.after]));
const errors=[];
for(const f of manifest.files){const expected=changes.get(f.path)||f.sha256;const p=path.join(root,f.path);if(!fs.existsSync(p)||createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==expected)errors.push(f.path);}
console.log(JSON.stringify({files:manifest.files.length,intentionalChanges:changes.size,failed:errors.length,errors}));
if(errors.length)process.exitCode=1;
