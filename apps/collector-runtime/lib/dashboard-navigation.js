import {dashboardIcon} from './dashboard-icons.js';
export const DASHBOARD_NAV_ITEMS=Object.freeze([
  Object.freeze({key:'signatures',href:'/dashboard/signatures',label:'풍벽지',icon:'wallpaper',title:'풍벽지'}),
  Object.freeze({key:'roulette-rules',href:'/dashboard/roulette-rules',label:'업보 분류 설정',icon:'rules',title:'업보 분류 설정'}),
  Object.freeze({key:'upbo',href:'/dashboard',label:'업보',icon:'tasks',title:'업보'})
]);

export function dashboardTitle(section){
  const item=DASHBOARD_NAV_ITEMS.find(candidate=>candidate.key===section)||DASHBOARD_NAV_ITEMS[0];
  return `별록 ${item.title}`;
}

export function dashboardNavigationHtml(activeSection){
  const links=DASHBOARD_NAV_ITEMS.map(item=>`<a${item.key===activeSection?' class="active"':''} href="${item.href}">${dashboardIcon(item.icon)}<span>${item.label}</span></a>`).join('');
  return `<nav class="productNav dashboardNav" aria-label="별록 대시보드">${links}</nav>`;
}

export function dashboardHeaderHtml(){
  return `<header class="dashboardHeader"><a class="dashboardBrand" href="/dashboard" title="대시보드로 돌아가기" aria-label="별록 대시보드"><span class="brandMark"></span><span class="brandWords">별록</span></a><div class="dashboardHeaderActions"><span class="dashboardConnectionDot" aria-hidden="true"></span><span id="connState" class="dashboardConnectionState">서버 연결 확인 중...</span><button type="button" id="dashboardMenuToggle" class="dashboardHeaderButton dashboardMenuToggle" aria-expanded="false" aria-controls="dashboardUtilities">메뉴</button><div id="dashboardUtilities" class="dashboardUtilities"><a id="soopConnectBtn" class="dashboardHeaderButton dashboardSoopConnect hidden" href="/api/auth/soop/start">SOOP 계정 연결하기</a><a class="dashboardHeaderButton" href="/setup">세팅 체크리스트</a><a class="dashboardHeaderButton" id="managementBtn" href="/dashboard?management=1">관리</a><button type="button" class="dashboardHeaderButton" id="myPageBtn">마이페이지</button><button type="button" class="dashboardHeaderButton dashboardThemeButton" id="themeToggleBtn" title="테마 전환" aria-label="테마 전환">${dashboardIcon('moon')}</button><button type="button" class="dashboardHeaderButton" id="logoutBtn">로그아웃</button></div></div></header>`;
}

export function dashboardFooterHtml(){
  return '<footer class="byeollogSiteFooter">© 2026 BYEOLLOG</footer>';
}

export function dashboardAccountModalHtml(){
  return `<div id="myPageModal" class="accountModal hidden" role="dialog" aria-modal="true" aria-labelledby="myPageTitle"><div class="accountDialog"><div class="accountDialogHead"><div><h2 id="myPageTitle">마이페이지</h2><div class="muted" id="myPageSub">계정 설정</div></div><button type="button" id="closeMyPage">닫기</button></div><div class="accountSettings"><div class="muted">표시 이름</div><div id="myPageName" class="accountName">관리자</div></div><div class="accountSettings soopAccount"><div class="soopAccountHead"><div><div class="muted">SOOP 방송 계정</div><div id="soopAccountState" class="soopAccountState">확인 중...</div></div><span id="soopAccountBadge" class="badge wait">확인 중</span></div><div id="soopAccountMeta" class="muted soopAccountMeta">연결 상태를 확인하고 있습니다.</div><div id="soopReadiness" class="soopAccountReadiness hidden"><div class="soopReadinessItem"><span>로그인 연결</span><b id="soopTokenState">확인 전</b></div><div class="soopReadinessItem"><span>방송 채팅</span><b id="soopChatState">방송 대기 중</b></div></div><div class="soopAccountActions"><a id="soopManageConnect" class="button primary" href="/api/auth/soop/start">SOOP 계정 연결</a><button id="soopDiagnoseBtn" type="button" class="hidden">연결 자가진단</button><button id="soopDisconnectBtn" type="button" class="danger hidden">연결 해제</button></div><div id="soopAccountMessage" class="status" aria-live="polite"></div></div><div class="accountActions"><a class="button primary" href="/change-password">비밀번호 변경</a><a class="button" href="/credits">크레딧 내역 · 현재 적립만 가능</a><a class="button danger" href="/withdraw.html">회원 탈퇴</a></div></div></div>`;
}

export function compactDashboardNavigation(html){
  const match=String(html).match(/<nav class="productNav dashboardNav" aria-label="별록 대시보드">[\s\S]*?<\/nav>/);
  return match?match[0].replace(/\s+/g,' ').replace(/> </g,'><').trim():'';
}

export function dashboardHeaderScript(){return String.raw`
const dashboardMenu=document.getElementById('dashboardMenuToggle');
dashboardMenu?.addEventListener('click',()=>{const expanded=dashboardMenu.getAttribute('aria-expanded')!=='true';dashboardMenu.setAttribute('aria-expanded',String(expanded));document.getElementById('dashboardUtilities').classList.toggle('menuOpen',expanded)});
`}
