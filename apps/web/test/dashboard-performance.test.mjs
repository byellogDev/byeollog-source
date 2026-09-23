import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ADMIN_HTML_BASE64} from '../lib/admin-html.js';
import {serializeInlineJson} from '../api/admin.js';
import {compactDashboardNavigation,dashboardNavigationHtml,dashboardTitle} from '../lib/dashboard-navigation.js';

const decoded=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
const source=await readFile(new URL('../lib/admin-source.html',import.meta.url),'utf8');
const adminApi=await readFile(new URL('../api/admin.js',import.meta.url),'utf8');
const vercelConfig=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));

test('dashboard uses the same official app icon as the Byeollog main page',()=>{
  assert.equal(decoded,source,'editable dashboard source must match the deployed base64 module');
  assert.match(decoded,new RegExp(`<title>${dashboardTitle('upbo')}<\\/title>`));
  assert.equal(compactDashboardNavigation(decoded),dashboardNavigationHtml('upbo'));
  assert.doesNotMatch(decoded,/\bdocument\.title\s*=/);
  assert.match(decoded,/rel="icon"[^>]+byeollog_app_icon\.png/);
  assert.doesNotMatch(decoded,/byeollog_favicon\.png/);
});

test('dashboard bootstrap collapses repeated authenticated table round trips',()=>{
  assert.match(adminApi,/operation==='dashboard-bootstrap'/);
  assert.match(adminApi,/requireCapabilityLive\(req,res,'data:read'\)/);
  assert.match(adminApi,/Promise\.all\(\[\s*sb\('byeollog_workspaces'/);
  for(const table of ['bangsel_tasks','bangsel_fan_stations','bangsel_fans','bangsel_roulette_rules','bangsel_task_import_items']){
    assert.match(adminApi,new RegExp(`sb\\('${table.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}'`));
  }
  assert.match(decoded,/fetch\('\/api\/admin\?operation=dashboard-bootstrap'/);
  assert.doesNotMatch(decoded,/await loadAdminContext\(\);\s*await loadServer\(\)/);
});

test('dashboard executes beside the Tokyo database and embeds first-paint data',()=>{
  assert.deepEqual(vercelConfig.regions,['hnd1']);
  assert.match(adminApi,/initialBootstrap=await loadDashboardBootstrapData\(liveSession\)/);
  assert.match(adminApi,/window\.__BYEOLLOG_DASHBOARD_BOOTSTRAP__/);
  assert.match(adminApi,/dashboard-embedded;dur=/);
  assert.match(decoded,/const embedded=globalThis\.__BYEOLLOG_DASHBOARD_BOOTSTRAP__/);
  assert.match(decoded,/if\(embedded&&embedded\.ok\)/);
  const serialized=serializeInlineJson({unsafe:'</script><img src=x>&\u2028'});
  assert.doesNotMatch(serialized,/[<>&\u2028\u2029]/);
  assert.match(serialized,/\\u003c\/script\\u003e/);
});

test('dashboard renders before maintenance and lazily reads local file blobs',()=>{
  assert.match(decoded,/await loadServer\(\);\s*await consumeSoopNavigationNotice\(\);\s*scheduleDashboardMaintenance\(\);\s*void loadPlatformAdminCapability\(\)/);
  assert.match(decoded,/requestIdleCallback\(start,\{timeout:1200\}\)/);
  assert.match(decoded,/visibleIds\.map\(id=>\[id,cachedFileCell\(id\)\]\)/);
  assert.doesNotMatch(decoded,/visibleIds\.map\(async id=>\[id,await fileCell\(id\)\]\)/);
  assert.match(decoded,/\.fanCard:not\(\.collapsed\) \[data-file-pending\]/);
});

test('collector classification updates immediately and performs one background refresh',()=>{
  const classifyStart=decoded.indexOf('async function classifyUnknownCollectorResult');
  const classifyEnd=decoded.indexOf('function openCollectorRuleManager',classifyStart);
  const classifyBlock=decoded.slice(classifyStart,classifyEnd);
  const managerStart=decoded.indexOf('async function saveCollectorRuleManager');
  const managerEnd=decoded.indexOf('let collectorClassifyUid',managerStart);
  const managerBlock=decoded.slice(managerStart,managerEnd);
  assert.ok(classifyStart>=0&&classifyEnd>classifyStart);
  assert.ok(managerStart>=0&&managerEnd>managerStart);
  assert.match(decoded,/rouletteRules\[name\]=row;\s*renderCollectorInbox\(\);/);
  assert.match(classifyBlock,/runCollectorAutoProcessingOnce\(\{refreshUi:false\}\)/);
  assert.match(classifyBlock,/void \(async\(\)=>\{/);
  assert.doesNotMatch(classifyBlock,/await runCollectorAutoProcessingOnce\(\)/);
  assert.match(managerBlock,/runCollectorAutoProcessingOnce\(\{refreshUi:false\}\)/);
  assert.match(managerBlock,/void \(async\(\)=>\{/);
  assert.doesNotMatch(managerBlock,/await runCollectorAutoProcessingOnce\(\)/);
});
