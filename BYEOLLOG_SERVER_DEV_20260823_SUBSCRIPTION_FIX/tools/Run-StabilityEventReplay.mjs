import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runStabilityEventReplay} from './stability-event-replay-core.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixturePath=resolve(root,'stability','fixtures','soop-event-replay-v1.json');
const reportArg=process.argv.indexOf('--report');
const reportPath=reportArg>=0&&process.argv[reportArg+1]?resolve(process.argv[reportArg+1]):null;
const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
const report=await runStabilityEventReplay(fixture);
if(reportPath){await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');}
process.stdout.write(`${JSON.stringify({passed:report.passed,mode:report.mode,summary:report.summary,failures:report.failures,reportPath})}\n`);
process.exitCode=report.passed?0:1;
