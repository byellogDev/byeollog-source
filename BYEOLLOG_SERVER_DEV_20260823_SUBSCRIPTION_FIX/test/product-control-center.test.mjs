import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  normalizeWeflabPublicUrl,
  parseWeflabPublicRouletteHtml,
  WeflabPublicImportError
} from '../lib/weflab-public-roulette-import.js';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {compactDashboardNavigation,dashboardNavigationHtml,dashboardTitle} from '../lib/dashboard-navigation.js';
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

test('public Weflab importer rejects product names over the 20 grapheme contract',()=>{
  const tooLong='가나다라마바사아자차카타파하거너더러머버보';
  const html=`<div id="setup_alert_list" name="item_roulette_donation" type="donation">
    ${roulette('33',[[tooLong,'50'],['정상 상품','50']])}
  </div>`;
  assert.throws(
    ()=>parseWeflabPublicRouletteHtml(html,{sourceUrl:'https://weflab.com/user/Abc_123-x'}),
    error=>error?.code==='weflab_item_invalid'&&/20자 이내/.test(error.message)
  );
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
  assert.match(upboPage,new RegExp(`<title>${dashboardTitle('upbo')}<\\/title>`));
  assert.doesNotMatch(upboPage,/\bdocument\.title\s*=/);
  assert.match(upboPage,/class="productNav dashboardNav"/);
  assert.equal(compactDashboardNavigation(upboPage),dashboardNavigationHtml('upbo'));
  for(const section of ['roulette','signatures','wallpaper','actions']){
    const page=getProductDashboardHtml('test-nonce',section);
    assert.match(page,new RegExp(`<title>${dashboardTitle(section)}<\\/title>`));
    assert.equal(compactDashboardNavigation(page),dashboardNavigationHtml(section));
  }
  assert.doesNotMatch(upboPage,/href="\/dashboard\/overlay"|▣ 오버레이/);
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

test('dashboard uses ultrawide space through 21:9 while preserving compact breakpoints',async()=>{
  const signatures=getProductDashboardHtml('test-nonce','signatures');
  const theme=await source('../assets/byeollog-theme.css');
  assert.match(signatures,/class="dashboard-page product-page"/);
  assert.match(signatures,/\.shell\{width:min\(calc\(100% - 32px\),2160px\);max-width:none/);
  assert.match(signatures,/\.signature-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(signatures,/@media\(max-width:1100px\)\{\.signature-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(theme,/\.admin-page \.wrap\{width:min\(calc\(100% - 32px\),2160px\)!important;max-width:none!important/);
  assert.match(theme,/\.dashboard-page \.dashboardNav\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)!important/);
  assert.match(theme,/@media\(max-width:820px\)[^{]*\{[^}]*\.dashboard-page \.dashboardHeader[\s\S]*\.dashboard-page \.dashboardNav\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
});

test('all dashboard tabs expose SOOP connect only while disconnected and manage it in My Page',async()=>{
  const product=getProductDashboardHtml('test-nonce','roulette');
  const upbo=await source('../lib/admin-source.html');
  for(const page of [product,upbo]){
    assert.match(page,/id="soopConnectBtn"[^>]*hidden[^>]*href="\/api\/auth\/soop\/start"/);
    assert.match(page,/id="soopAccountState"/);
    assert.match(page,/id="soopManageConnect"[^>]*href="\/api\/auth\/soop\/start"/);
    assert.match(page,/id="soopDisconnectBtn"/);
    assert.match(page,/\/api\/auth\/soop\/status/);
    assert.match(page,/\/api\/auth\/soop\/disconnect/);
    assert.match(page,/classList\.toggle\('hidden',connected\|\|!available\)/);
  }
});

test('roulette import defers naming to editor and editor owns only roulette settings',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.match(page,/룰렛으로 가져오기/);
  assert.match(page,/button\.onclick=\(\)=>openEditor/);
  assert.match(page,/id="rouletteName"/);
  assert.doesNotMatch(page,/새 룰렛명 \(필수\)/);
  for(const removed of ['agentDevice','soundVolume','ttsVolume','multipleSpins','followupWindow']){
    assert.doesNotMatch(page,new RegExp(`id="${removed}"`));
  }
  assert.match(page,/id="seriesEnabled"/);
  assert.match(page,/id="seriesBalloons"[^>]*disabled/);
  assert.match(page,/id="seriesSpinCount"[^>]*disabled/);
  assert.match(page,/function syncSeriesFields\(\)[^\n]*disabled=!enabled/);
  assert.match(page,/화면 위치와 크기는 OBS의 브라우저 소스에서 직접 조절/);
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
  assert.match(page,/name\.setAttribute\('aria-label',\(index\+1\)\+'번 상품명 · 최대 20자'\)/);
  assert.match(page,/name\.placeholder='상품명 \(최대 20자\)'/);
  assert.match(page,/if\(clamp\)value=limitGraphemes\(value,20\)/);
  assert.match(page,/event\.isComposing/);
  assert.match(page,/name\.oncompositionend/);
  assert.match(page,/firstProductNameIssue\(\)/);
  assert.match(page,/aria-invalid/);
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
  assert.match(admin,/img-src 'self' data: \$\{assetOrigin\} https:\/\/sooplive\.com https:\/\/\*\.sooplive\.com[^`]*; connect-src 'self' \$\{assetOrigin\}/);
  assert.doesNotMatch(page,/SUPABASE_(?:SECRET|SERVICE_ROLE)/);
});

test('roulette choices render the actual reviewed preview instead of a generic color bar',()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  assert.match(page,/preview\.className='asset-preview'/);
  assert.match(page,/preview\.src=asset\.previewUrl/);
  assert.match(page,/실제 룰렛 미리보기/);
  assert.doesNotMatch(page,/asset-swatch/);
});

test('roulette dashboard exposes production activation and OBS controls without test systems',async()=>{
  const page=getProductDashboardHtml('test-nonce','roulette');
  const admin=await source('../api/admin.js');
  for(const label of ['1 · SOOP 계정','2 · 실시간 연결','3 · 방송 상태','4 · 방송 적용본'])assert.match(page,new RegExp(label.replace('·','\\·')));
  assert.match(page,/id="copyOverlayBtn"/);
  assert.match(page,/id="pauseRouletteBtn"/);
  assert.match(page,/id="rotateOverlayBtn"/);
  assert.match(page,/id="donationTestToggleBtn"/);
  assert.match(page,/id="donationTestPreset"/);
  assert.match(page,/id="donationTestAmount"[^>]*min="1"[^>]*max="1000000"/);
  assert.match(page,/id="donationTestMessage" maxlength="120"/);
  assert.match(page,/id="runDonationTestBtn"/);
  assert.match(page,/일반풍·등록 시그풍·룰렛 후원/);
  assert.match(page,/통계, 업보, 액션, 풍벽지 기록에 반영되지 않습니다/);
  assert.match(page,/ordinaryDonationTestAmount/);
  assert.match(page,/request\('signature-balloon-registry'\)/);
  assert.match(page,/후원 멘트를 TTS로 읽습니다/);
  assert.match(page,/action:'donation-test',amount,message/);
  assert.match(page,/\$\('donationTestToggleBtn'\)\.disabled=!active/);
  assert.match(page,/공통 OBS 주소 복사/);
  assert.match(page,/룰렛·시그풍 공통 OBS 브라우저 소스 주소/);
  assert.doesNotMatch(page,/href="\/dashboard\/overlay"|preview-overlay-part|update-overlay-part-layout/);
  assert.match(page,/request\('soop-runtime-status'/);
  assert.match(page,/request\('native-roulette-service'/);
  assert.doesNotMatch(page,/syntheticE2eBtn|liveDiagnosticBtn|실험 오버레이|가상 후원/);
  assert.match(admin,/activate_native_roulette_service_v2/);
  assert.match(admin,/pause_native_roulette_service_v2/);
  assert.match(admin,/rotate_native_roulette_overlay_token_v2/);
  assert.match(admin,/action==='donation-test'/);
  assert.match(admin,/normalizeSoopSdkRelayEnvelope/);
  assert.match(admin,/ingestNormalizedSoopDonation\(workspaceId,relay,\{testMode:true\}\)/);
  assert.match(admin,/id:'byeollog-overlay-test',name:'후원 테스트'/);
  assert.doesNotMatch(admin,/update_overlay_part_layout_v1|request_overlay_part_preview_v1/);
  assert.match(admin,/operation==='soop-runtime-status'/);
  assert.match(admin,/operation==='native-roulette-service'/);
  assert.doesNotMatch(admin,/operation==='soop-live-diagnostic'|operation==='soop-synthetic-e2e'|handleSoopRouletteExperiment/);
  const scripts=[...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  assert.ok(scripts.length>0);
  for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
});

test('signature registration and common OBS source replace web overlay placement',async()=>{
  const signatures=getProductDashboardHtml('test-nonce','signatures');
  const roulette=getProductDashboardHtml('test-nonce','roulette');
  const routes=await source('../vercel.json');
  assert.match(signatures,/<title>별록 시그풍<\/title>/);
  assert.match(signatures,/href="\/dashboard\/signatures">✹ 시그풍<\/a>/);
  assert.match(signatures,/id="signatureBalloonCount"/);
  assert.match(signatures,/id="signaturePcUpload"/);
  assert.match(signatures,/id="signatureMobileUpload"/);
  assert.match(signatures,/id="signatureWallpaperPreview"/);
  assert.match(signatures,/풍벽지용 이미지[\s\S]*자동 생성/);
  assert.doesNotMatch(signatures,/id="signatureWallpaperUpload"/);
  assert.match(signatures,/등록한 시그풍이 가장 먼저 사용되고[\s\S]*SOOP이 이벤트로 전달한 이미지[\s\S]*SOOP 공식 기본 이미지[\s\S]*임의 이미지를 생성하지 않습니다/);
  assert.doesNotMatch(signatures,/별록 기본 이미지가 표시/);
  assert.match(roulette,/460×450/);
  assert.match(roulette,/후원 종류 강조 영역과 최대 120자 후원 멘트를 수용하는 고정 경계/);
  assert.doesNotMatch(signatures+roulette,/href="\/dashboard\/overlay"|id="overlayLayoutCanvas"|update-overlay-part-layout|preview-overlay-part/);
  assert.match(routes,/"source": "\/dashboard\/overlay"[\s\S]{0,100}"destination": "\/dashboard\/roulette"[\s\S]{0,50}"permanent": true/);
  const scripts=[...signatures.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
});

test('web wallpaper editor stacks a merged 20-card range into two continuous 10-card columns',async()=>{
  const dashboard=await source('../lib/product-dashboard-html.js');
  const start=dashboard.indexOf('function fitWallpaperDraftGroup');
  const end=dashboard.indexOf('\nfunction wallpaperCardStyle',start);
  assert.ok(start>=0&&end>start);
  const fit=new Function(`${dashboard.slice(start,end)};return fitWallpaperDraftGroup;`)();
  const amounts=[...Array(12).fill(1),2,3,5,7,9,10,10,11];
  const group={width:720,height:640,nextSide:'right',mergeRange:{min:1,max:32},cards:amounts.map((amount,index)=>({id:index,amount}))};
  fit(group);
  assert.equal(group.rowsPerColumn,10);
  assert.equal(group.columns,2);
  const laneCounts=[...group.cards.reduce((lanes,card)=>lanes.set(card.x,(lanes.get(card.x)||0)+1),new Map()).values()];
  assert.deepEqual(laneCounts,[10,10]);
  assert.deepEqual(group.cards.slice(10).map(card=>card.amount),[1,1,2,3,5,7,9,10,10,11]);
});

test('web wallpaper control is a first-class dashboard page without post-render patching',async()=>{
  const page=getProductDashboardHtml('test-nonce','wallpaper');
  const implementation=await source('../lib/product-dashboard-html.js');
  const routes=await source('../vercel.json');
  assert.match(page,/<title>별록 풍벽지<\/title>/);
  assert.match(page,/id="wallpaperPreview"/);
  assert.match(page,/id="copyWallpaperBtn"/);
  assert.match(page,/id="resetWallpaperBtn"/);
  assert.match(page,/Agent 풍벽지 주소 복사/);
  assert.match(page,/Agent의 별록 풍벽지 주소를 아래에, 별록 액션 주소를 위에/);
  assert.match(page,/구형 웹 풍벽지 주소는 종료/);
  assert.match(page,/request\('wallpaper-control'/);
  assert.match(routes,/"source": "\/dashboard\/wallpaper"/);
  assert.doesNotMatch(implementation,/const oldPriority|const oldMobile|return html\s*\.replace/);
});
