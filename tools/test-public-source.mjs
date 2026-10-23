import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const exclusions=JSON.parse(fs.readFileSync(new URL('../docs/public-source/test-exclusions.json',import.meta.url)));
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const files=['tests','tests/adapted'].flatMap(dir=>fs.readdirSync(dir).filter(f=>f.endsWith('.test.mjs')).map(f=>`${dir}/${f}`));
for(const item of exclusions)console.log(`PUBLIC SOURCE EXCLUSION: ${item.name}\n  ${item.reason}`);
const result=spawnSync(process.execPath,['--test','--test-timeout=45000','--test-reporter=tap',`--test-skip-pattern=^(?:${exclusions.map(x=>escape(x.name)).join('|')})$`,...files],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
