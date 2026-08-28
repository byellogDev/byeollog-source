import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  normalizeWeflabPublicUrl,
  parseWeflabPublicRouletteHtml,
  WeflabPublicImportError
} from '../lib/weflab-public-roulette-import.js';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {normalizeNativeRouletteWebDraft,NativeRouletteValidationError} from '../lib/native-roulette.js';

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
  assert.match(roulettePage,/열린 편집 화면에서 새 룰렛명을 입력/);
  assert.match(roulettePage,/업보로 지정/);
  assert.match(roulettePage,/시청자 확률표 공개 예약/);
  assert.match(actionPage,/기존 액션 규칙은 이미 서버에 저장/);
  const admin=await source('../api/admin.js');
  assert.match(admin,/operation==='product-control-state'/);
  assert.match(admin,/operation==='weflab-public-import'/);
  assert.match(admin,/operation==='roulette-draft'/);
  assert.match(admin,/handleProductControlPage[\s\S]*style-src 'self' 'nonce-\$\{nonce\}'/);
  assert.match(admin,/handleProductControlPage[\s\S]*style-src-attr 'none'/);
  assert.doesNotMatch(admin,/service_role[^\n]+browser/i);
});

test('roulette import defers naming to editor and editor owns only roulette settings',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.match(page,/초안으로 가져오기/);
  assert.match(page,/button\.onclick=\(\)=>openEditor/);
  assert.match(page,/id="rouletteName"/);
  assert.doesNotMatch(page,/새 룰렛명 \(필수\)/);
  for(const removed of ['agentDevice','soundVolume','ttsVolume','multipleSpins']){
    assert.doesNotMatch(page,new RegExp(`id="${removed}"`));
  }
  assert.match(page,/id="seriesEnabled"/);
  assert.match(page,/id="seriesBalloons"[^>]*disabled/);
  assert.match(page,/id="seriesSpinCount"[^>]*disabled/);
  assert.match(page,/function syncSeriesFields\(\)[^\n]*disabled=!enabled/);
  assert.match(page,/PC 연결과 효과음·TTS 음량은 오버레이 페이지에서 공통 관리/);
});

test('web roulette draft validates optional series settings and strips overlay-owned values',()=>{
  const base={
    name:'테스트 룰렛',balloonsPerSpin:30,overlayAssetKey:'roulette_navy_gold_v1',
    followupChatTtsWindowSeconds:10,
    items:[
      {resultText:'당첨',probabilityPpm:500000,directUpbo:false,ttsText:'당첨!'},
      {resultText:'꽝',probabilityPpm:500000,directUpbo:false,ttsText:'꽝!'}
    ],
    agentDeviceId:'00000000-0000-4000-8000-000000000000',
    soundVolumePercent:12,ttsVolumePercent:34,allowMultipleSpins:true
  };
  const disabled=normalizeNativeRouletteWebDraft({...base,seriesEnabled:false,seriesBalloons:999,seriesSpinCount:999});
  assert.equal(disabled.seriesEnabled,false);
  assert.equal(disabled.seriesBalloons,null);
  assert.equal(disabled.seriesSpinCount,null);
  for(const removed of ['agentDeviceId','soundVolumePercent','ttsVolumePercent','allowMultipleSpins']){
    assert.equal(Object.hasOwn(disabled,removed),false);
  }
  const enabled=normalizeNativeRouletteWebDraft({...base,seriesEnabled:true,seriesBalloons:100,seriesSpinCount:4});
  assert.deepEqual([enabled.seriesEnabled,enabled.seriesBalloons,enabled.seriesSpinCount],[true,100,4]);
  assert.throws(
    ()=>normalizeNativeRouletteWebDraft({...base,seriesEnabled:true,seriesBalloons:'',seriesSpinCount:4}),
    NativeRouletteValidationError
  );
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

test('roulette editor preserves and accepts probability decimals through the rendered template',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.match(page,/function percent\(ppm\)\{[^\n]*replace\(\/\\\.\?0\+\$\//);
  assert.match(page,/function ppm\(value\)\{[^\n]*match\(\/\^\(\\d\{1,3\}\)\(\?:\\\.\(\\d\{1,4\}\)\)\?\$\//);
  const percentBody=page.match(/function percent\(ppm\)\{([^\n]+)\}/)?.[1];
  assert.ok(percentBody);
  const percent=new Function('ppm',percentBody);
  assert.deepEqual([1,10,100,1000,1250,10000,1000000].map(percent),['0.0001','0.001','0.01','0.1','0.125','1','100']);
});

test('roulette product rows are compact without repeated visible field labels',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.doesNotMatch(page,/nameLabel\.textContent='상품명'/);
  assert.doesNotMatch(page,/probLabel\.textContent='확률\(%\)'/);
  assert.match(page,/name\.setAttribute\('aria-label',\(index\+1\)\+'번 상품명'\)/);
  assert.match(page,/prob\.setAttribute\('aria-label',\(index\+1\)\+'번 확률\(%\)'\)/);
  assert.match(page,/\.item\{align-items:center;padding:7px 9px/);
  assert.match(page,/\.item \.field input\{height:36px/);
});

test('roulette editor supports authenticated custom single and optional series images',async()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  const admin=await source('../api/admin.js');
  assert.match(page,/id="singleImageUpload"[^>]*image\/png,image\/jpeg,image\/webp,image\/gif/);
  assert.match(page,/id="seriesImagePanel" class="upload-panel hidden"/);
  assert.match(page,/연차 이미지를 별도로 지정하지 않으면 단차 이미지를 사용합니다\./);
  assert.match(page,/request\('roulette-image-upload-ticket'/);
  assert.match(page,/request\('roulette-image-confirm'/);
  assert.match(page,/customSeriesImage:seriesEnabled\?state\.customSeriesImage:null/);
  assert.match(admin,/operation==='roulette-image-upload-ticket'\|\|operation==='roulette-image-confirm'/);
  assert.match(admin,/await verifyDraftCustomAssets\(workspaceId,draft\)/);
  assert.match(admin,/img-src 'self' data: \$\{assetOrigin\}; connect-src 'self' \$\{assetOrigin\}/);
  assert.doesNotMatch(page,/SUPABASE_(?:SECRET|SERVICE_ROLE)/);
});

test('roulette choices render the actual reviewed preview instead of a generic color bar',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.match(page,/preview\.className='asset-preview'/);
  assert.match(page,/preview\.src=asset\.previewUrl/);
  assert.match(page,/실제 룰렛 미리보기/);
  assert.doesNotMatch(page,/asset-swatch/);
});
