import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const toolDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(toolDir);
const sourcePath=path.join(root,'lib','admin-source.html');
const modulePath=path.join(root,'lib','admin-html.js');
const html=await readFile(sourcePath,'utf8');

if(!html.startsWith('<!doctype html>')||!html.includes('<title>별록 대시보드</title>')){
  throw new Error('admin-source.html identity check failed');
}

const encoded=Buffer.from(html,'utf8').toString('base64');
await writeFile(modulePath,`export const ADMIN_HTML_BASE64 = '${encoded}';\n`,'utf8');
console.log(`admin-html.js regenerated: ${Buffer.byteLength(html,'utf8')} HTML bytes`);
