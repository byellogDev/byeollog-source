export function dashboardNotificationsScript(){return String.raw`
let dashboardCountTimer=null,dashboardCountsBusy=false,dashboardCountFailures=0,dashboardCountsSignedOut=false;
function setDashboardCount(id,count,label){
  const badge=document.getElementById(id);if(!badge)return;
  const valid=Number.isSafeInteger(count)&&count>=0;
  badge.hidden=valid&&count===0;
  badge.textContent=valid?(count>999?'999+':String(count)):'?';
  badge.title=valid?label+' '+count.toLocaleString()+'건':'현재 건수를 확인하지 못했습니다.';
  badge.setAttribute('aria-label',badge.title);
}
async function refreshDashboardCounts(){
  clearTimeout(dashboardCountTimer);
  if(document.hidden||dashboardCountsBusy||dashboardCountsSignedOut)return;
  dashboardCountsBusy=true;
  try{
    const response=await fetch('/api/admin?operation=ux-controls&kind=notifications',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.status===401){dashboardCountsSignedOut=true;clearTimeout(dashboardCountTimer);return}
    if(!response.ok)throw Error('count unavailable');
    const data=await response.json();
    setDashboardCount('collectorCountBadge',data.reviewCount,'학습 필요한 별풍선');
    setDashboardCount('roulettePendingBadge',data.pendingCount,'룰렛 연결 대기');
    setDashboardCount('rouletteExceptionsBadge',data.exceptionCount,'예외 처리된 룰렛 보류');
    dashboardCountFailures=0;
  }catch{
    dashboardCountFailures++;
    setDashboardCount('collectorCountBadge',null,'학습 필요한 별풍선');
    setDashboardCount('roulettePendingBadge',null,'룰렛 연결 대기');
    setDashboardCount('rouletteExceptionsBadge',null,'예외 처리된 룰렛 보류');
  }finally{
    dashboardCountsBusy=false;
    if(!document.hidden&&!dashboardCountsSignedOut)dashboardCountTimer=setTimeout(refreshDashboardCounts,Math.min(120000,30000*2**dashboardCountFailures));
  }
}
function toggleDashboardReviewPanel(kind,forceOpen=false){
  const panels={learning:['collectorBox','toggleCollectorBtn'],pending:['roulettePendingPanel','toggleRoulettePendingBtn'],exceptions:['exceptionsPanel','toggleRouletteExceptionsBtn']};
  const target=panels[kind];if(!target)return;
  const open=forceOpen||document.getElementById(target[0]).classList.contains('hidden');
  if(!window.dashboardExceptionPanel.close())return;
  closeCollectorClassify();closeCollectorRuleManager();
  for(const [key,[panelId,buttonId]]of Object.entries(panels)){
    const active=open&&key===kind,button=document.getElementById(buttonId);
    document.getElementById(panelId).classList.toggle('hidden',!active);
    button.classList.toggle('active',active);button.setAttribute('aria-expanded',String(active));button.setAttribute('aria-pressed',String(active));
  }
  if(open){if(kind==='learning')void loadCollectorInbox(false);else if(kind==='pending')void uxRefreshStatus();else void window.dashboardExceptionPanel.load()}
}
document.querySelectorAll('[data-review-close]').forEach(button=>button.addEventListener('click',()=>{
 const kind=button.dataset.reviewClose;toggleDashboardReviewPanel(kind);
 const target={learning:'toggleCollectorBtn',pending:'toggleRoulettePendingBtn',exceptions:'toggleRouletteExceptionsBtn'}[kind];
 if(document.getElementById(target)?.getAttribute('aria-expanded')==='false')document.getElementById(target).focus();
}));
document.getElementById('toggleRoulettePendingBtn').onclick=()=>toggleDashboardReviewPanel('pending');
document.getElementById('toggleRouletteExceptionsBtn').onclick=()=>toggleDashboardReviewPanel('exceptions');
window.addEventListener('byeollog:exceptions-updated',()=>{void refreshDashboardCounts()});
window.addEventListener('byeollog:exception-resolved',()=>{void loadServer()});
function openSetupDestination(){const kind=location.hash.slice(1);if(['exceptions','pending','learning'].includes(kind))toggleDashboardReviewPanel(kind,true);else if(kind==='account')openMyPage();else if(kind==='history')openRecentCollectorHistory()}
window.addEventListener('hashchange',openSetupDestination);
queueMicrotask(openSetupDestination);
document.addEventListener('visibilitychange',()=>{clearTimeout(dashboardCountTimer);if(!document.hidden)void refreshDashboardCounts()});
window.addEventListener('pagehide',()=>clearTimeout(dashboardCountTimer));
queueMicrotask(refreshDashboardCounts);
`}
