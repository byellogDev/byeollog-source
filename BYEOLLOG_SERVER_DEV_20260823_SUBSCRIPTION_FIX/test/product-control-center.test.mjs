import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  normalizeWeflabPublicUrl,
  parseWeflabPublicRouletteHtml,
  WeflabPublicImportError
} from '../lib/weflab-public-roulette-import.js';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';

const source=relative=>readFile(new URL(relative,import.meta.url),'utf8');

const roulette=(amount,items)=>`<div class="alert_box sub_content_box active">
<span class="value min">${amount}</span>개
${items.map(([name,percent])=>`<div class="roulette_box add_box flex_box">
<input value="텍스트" class="input_text select_roulette_type">
<input value="${name}" class="input_text input_roulette_name">
<input value="${percent}" class="input_text decimal right input_roulette_percent">
</div>`).join('')}</div>`;

test('public Weflab importer accepts only the exact public URL boundary',()=>{
  assert.equal(normalizeWeflabPublicUrl('https://weflab.com/user/Abc_123-x'),'https://weflab.com/user/Abc_123-x');
  for(const url of [
    'http://weflab.com/user/Abc_123-x','https://evil.example/user/Abc_123-x',
    'https://weflab.com:444/user/Abc_123-x','https://weflab.com/user/Abc_123-x?token=x',
    'https://weflab.com/setup/roulette'
  ])assert.throws(()=>normalizeWeflabPublicUrl(url),WeflabPublicImportError);
});

test('public Weflab importer separates amount tiers and preserves exact probability',()=>{
  const html=`<div id="setup_alert_list" name="item_roulette_donation" type="donation">
    ${roulette('33',[['A & B','25'],['휴식','75']])}
    ${roulette('1,000',[['당첨','0.125'],['꽝','99.875']])}
  </div>`;
  const result=parseWeflabPublicRouletteHtml(html,{sourceUrl:'https://weflab.com/user/Abc_123-x'});
  assert.equal(result.groups.length,2);
  assert.deepEqual(result.groups.map(group=>group.balloonsPerSpin),[33,1000]);
  assert.deepEqual(result.groups[0].items.map(item=>[item.resultText,item.probabilityPpm]),[['A & B',250000],['휴식',750000]]);
  assert.equal(result.groups[1].items.reduce((sum,item)=>sum+item.probabilityPpm,0),1000000);
  assert.match(result.sourceFingerprint,/^[0-9a-f]{64}$/);
});

test('control center keeps roulette, action and existing upbo navigation organic',async()=>{
  const roulettePage=getProductDashboardHtml('test-nonce','roulette');
  const actionPage=getProductDashboardHtml('test-nonce','actions');
  const upboPage=await source('../lib/admin-source.html');
  for(const page of [roulettePage,actionPage]){
    assert.match(page,/\/dashboard\/roulette/);
    assert.match(page,/\/dashboard\/actions/);
    assert.match(page,/href="\/dashboard">✓ 업보/);
    assert.match(page,/룰렛명/);
    assert.match(page,/class="dashboardHeader"/);
    assert.match(page,/class="productNav dashboardNav"/);
    assert.match(page,/id="myPageBtn"/);
    assert.match(page,/id="themeToggleBtn"/);
    assert.match(page,/id="logoutBtn"/);
    assert.match(page,/byeollogAdminTheme/);
  }
  assert.match(upboPage,/class="top brandBanner dashboardHeader"/);
  assert.match(upboPage,/class="productNav dashboardNav"/);
  assert.match(upboPage,/class="admin-page dashboard-page"/);
  assert.match(roulettePage,/requires|각 룰렛마다 새로 입력/);
  assert.match(roulettePage,/업보로 지정/);
  assert.match(roulettePage,/시청자 확률표 공개 예약/);
  assert.match(actionPage,/기존 액션 규칙은 이미 서버에 저장/);
  const admin=await source('../api/admin.js');
  assert.match(admin,/operation==='product-control-state'/);
  assert.match(admin,/operation==='weflab-public-import'/);
  assert.match(admin,/operation==='roulette-draft'/);
  assert.doesNotMatch(admin,/service_role[^\n]+browser/i);
});

test('draft migration is server-only, workspace indexed and RLS protected',async()=>{
  const sql=await source('../supabase/migrations/20260827164017_add_web_product_control_plane.sql');
  assert.match(sql,/create table public\.byeollog_roulette_drafts/);
  assert.match(sql,/workspace_id uuid not null references public\.byeollog_workspaces/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/for all to anon, authenticated[\s\S]*using \(false\) with check \(false\)/);
  assert.match(sql,/revoke all on table public\.byeollog_roulette_drafts[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant select,insert,update,delete[\s\S]*to service_role/);
  assert.match(sql,/workspace_updated_idx/);
});

test('viewer roulette publication is opt-in twice and hidden by default',async()=>{
  const [visibilitySql,viewer,dataApi]=await Promise.all([
    source('../supabase/migrations/20260827164651_add_roulette_public_visibility.sql'),
    source('../bangsel_public_workspace_isolation.html'),
    source('../api/data.js')
  ]);
  assert.match(visibilitySql,/public_visible boolean not null default false/i);
  assert.match(visibilitySql,/where public_visible/i);
  assert.match(viewer,/id="viewerTabs"[^>]*hidden/);
  assert.match(viewer,/id="rouletteView" hidden/);
  assert.match(viewer,/operation=public-roulette/);
  assert.match(viewer,/workspace\.viewer_roulette_enabled===true/);
  assert.match(dataApi,/VIEWER_ROULETTE_PUBLIC_ENABLED==='true'/);
  assert.match(dataApi,/viewer_roulette_enabled:publicRouletteViewerEnabled\(\)/);
  assert.match(dataApi,/public_visible=eq\.true/);
  assert.match(dataApi,/items\.push\(\{resultText,probabilityPpm\}\)/);
});

test('upbo dashboard keeps its default route and uses roulette naming',async()=>{
  const dashboard=await source('../lib/admin-source.html');
  const vercel=JSON.parse(await source('../vercel.json'));
  assert.match(dashboard,/class="productNav dashboardNav"/);
  assert.match(dashboard,/팬 \/ 룰렛명 \/ 업보종류 검색/);
  assert.match(dashboard,/<label>룰렛명<\/label><input id="event">/);
  assert.ok(vercel.rewrites.some(item=>item.source==='/dashboard'&&item.destination==='/api/admin'));
  assert.ok(vercel.rewrites.some(item=>item.source==='/dashboard/roulette'&&item.destination==='/api/admin?view=roulette'));
  assert.ok(vercel.rewrites.some(item=>item.source==='/dashboard/actions'&&item.destination==='/api/admin?view=actions'));
});

test('all dashboard tabs share the action-style active color contract',async()=>{
  const theme=await source('../assets/byeollog-theme.css');
  assert.match(theme,/\.dashboard-page \.dashboardNav a\.active\{[^}]*background:#102746!important[^}]*color:#ffc44d!important/);
  assert.match(theme,/\.dashboard-page\[data-theme="dark"\] \.dashboardNav a\.active\{[^}]*background:#26344f!important[^}]*color:#ffd66f!important/);
});
