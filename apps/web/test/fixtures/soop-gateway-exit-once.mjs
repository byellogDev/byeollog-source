import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const directory=process.env.SOOP_GATEWAY_STATE_DIR;
const marker=join(directory,'self-test-child-marker');
await mkdir(directory,{recursive:true});
try{await readFile(marker,'utf8')}catch{await writeFile(marker,'first-exit','utf8');process.exit(27)}
const timer=setInterval(()=>{},1_000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);process.exit(0)});
