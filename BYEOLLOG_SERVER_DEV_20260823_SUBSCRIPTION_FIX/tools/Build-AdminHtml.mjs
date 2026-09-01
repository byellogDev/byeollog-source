import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compactDashboardNavigation,dashboardNavigationHtml,dashboardTitle} from '../lib/dashboard-navigation.js';

const toolDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(toolDir);
const sourcePath=path.join(root,'lib','admin-source.html');
const modulePath=path.join(root,'lib','admin-html.js');
const html=await readFile(sourcePath,'utf8');

if(!html.startsWith('<!doctype html>')||!html.includes(`<title>${dashboardTitle('upbo')}</title>`)){
  throw new Error('admin-source.html identity check failed');
}
if(compactDashboardNavigation(html)!==dashboardNavigationHtml('upbo')){
  throw new Error('admin navigation is stale; update admin-source.html from dashboard-navigation.js');
}
if(/\bdocument\.title\s*=/.test(html)){
  throw new Error('admin runtime must not override the shared dashboard title');
}

const encoded=Buffer.from(html,'utf8').toString('base64');
await writeFile(modulePath,`export const ADMIN_HTML_BASE64 = '${encoded}';\n`,'utf8');
console.log(`admin-html.js regenerated: ${Buffer.byteLength(html,'utf8')} HTML bytes`);
