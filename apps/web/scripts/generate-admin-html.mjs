import {dashboardLearningHtml} from '../lib/dashboard-review-shell.js';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {dashboardHeaderScript,dashboardHeaderHtml,dashboardNavigationHtml} from '../lib/dashboard-navigation.js';
import {dashboardIcon} from '../lib/dashboard-icons.js';
import {uxRouletteHtml,uxRouletteScript} from '../lib/ux-roulette-html.js';
import {dashboardExceptionsHtml,dashboardReviewCss,dashboardExceptionsScript} from '../lib/dashboard-review-panels.js';
import {dashboardNotificationsScript} from '../lib/dashboard-notifications.js';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const original=await readFile(join(root,'lib','admin-source.html'),'utf8');
let html=original;
const slots={header:dashboardHeaderHtml(),navigation:dashboardNavigationHtml('upbo'),pending:'<div id="dashboardReviewPanels" class="dashboardReviewPanels">'+dashboardLearningHtml()+'<section id="roulettePendingPanel" class="reviewPanel hidden" aria-labelledby="pendingReviewTitle">'+uxRouletteHtml()+'</section>'+dashboardExceptionsHtml()+'</div>',reviewStyle:dashboardReviewCss(),pendingScript:dashboardHeaderScript()+uxRouletteScript()+dashboardExceptionsScript()+dashboardNotificationsScript()};
slots.donationReportScript=await readFile(join(root,'lib','donation-report-client.js'),'utf8');
for(const [name,value] of Object.entries(slots)){
  const begin='<!-- shared:'+name+' -->',end='<!-- /shared:'+name+' -->';
  // Script slots use JS comments to remain valid inside <script>.
  const left=(name.endsWith('Script')||name.endsWith('Style'))?'/* shared:'+name+' */':begin,right=(name.endsWith('Script')||name.endsWith('Style'))?'/* /shared:'+name+' */':end;
  const start=html.indexOf(left),finish=html.indexOf(right,start);
  if(start<0||finish<0)throw Error('Missing shared slot '+name);
  html=html.slice(0,start+left.length)+'\n'+value+'\n'+html.slice(finish);
}
const iconNames={users:'users',nonupbo:'archive',history:'history',completionHistory:'tasks',rules:'rules',collectorDevices:'status',rouletteRecords:'roulette',signupApplications:'tasks',inquiries:'mail',stats:'chart',backup:'backup'};
html=html.replace(/(onclick="openManagementItem\('([^']+)'\)"[^>]*><span class="managementIcon">)[\s\S]*?(<\/span>)/g,(all,start,key,end)=>start+dashboardIcon(iconNames[key])+end);
html=html.replace(/(id="agentRolloutCard"[^>]*><span class="managementIcon">)[\s\S]*?(<\/span>)/g,(_,start,end)=>start+dashboardIcon('status')+end);
html=html.replace(/b\.(?:textContent|innerHTML)=dark\?[^;]*;|b\.replaceChildren\([^\n]*?\.documentElement\);/, 'b.replaceChildren(new DOMParser().parseFromString(dark?'+JSON.stringify(dashboardIcon('sun'))+':'+JSON.stringify(dashboardIcon('moon'))+',"image/svg+xml").documentElement);');
const source=Buffer.from(html,'utf8');
const generated=`export const ADMIN_HTML_BASE64 = '${source.toString('base64')}';\n`;
if(process.argv.includes('--check')){
  if(html!==original||await readFile(join(root,'lib','admin-html.js'),'utf8')!==generated)throw Error('Shared dashboard markup is stale. Run npm run ui:generate.');
}else{
  await writeFile(join(root,'lib','admin-source.html'),html,'utf8');
  await writeFile(join(root,'lib','admin-html.js'),generated,'utf8');
}
