const checks=[...document.querySelectorAll('[data-step]')],key='byeollog-setup-checklist-v1';
function progress(){document.getElementById('setupProgress').textContent=checks.filter(c=>c.checked).length+' / '+checks.length+'단계 확인 · 이 브라우저에 저장';try{localStorage.setItem(key,JSON.stringify(checks.filter(c=>c.checked).map(c=>c.dataset.step)))}catch{document.getElementById('setupProgress').textContent+=' (브라우저 저장 불가)'}}
try{const saved=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(saved))for(const c of checks)c.checked=saved.includes(c.dataset.step)}catch{}
for(const c of checks)c.addEventListener('change',progress);
document.getElementById('resetSetup').onclick=()=>{for(const c of checks)c.checked=false;progress()};progress();

// One snapshot on entry, then explicit refreshes only. Never probe localhost.
let readinessBusy=false,readinessAfter=0;
const readyEl=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
function readinessCard(title,label,detail,href,action,ok=false){const card=readyEl('article');card.className='readiness-card';const badge=readyEl('span',label);badge.className='readiness-badge';badge.dataset.state=ok?'ok':'check';card.append(readyEl('h3',title),badge,readyEl('p',detail));if(href){const a=readyEl('a',action);a.href=href;a.className='button';card.append(a)}return card}
async function refreshReadiness(){
 if(readinessBusy||Date.now()<readinessAfter)return;readinessBusy=true;
 const button=document.getElementById('refreshReadiness'),status=document.getElementById('readinessStatus'),cards=document.getElementById('readinessCards');button.disabled=true;
 status.textContent='현재 연결 상태를 확인하고 있습니다.';cards.replaceChildren();
 try{const r=await fetch('/api/admin?operation=ux-controls&kind=readiness',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});if(r.status===401||r.status===403){status.textContent=r.status===401?'로그인하면 내 계정의 준비 상태를 확인할 수 있습니다.':'이 계정은 준비 상태를 조회할 권한이 없습니다.';cards.append(readinessCard('계정 확인','로그인 필요','안내는 로그인 없이도 읽을 수 있습니다.','/login','로그인'));return}if(!r.ok)throw Error();const d=await r.json();if(!d.ok||!d.connection||!d.agent||!d.roulette||!d.collection)throw Error();
 const connected=d.connection.state==='connected',online=d.agent.state==='online',configured=d.roulette.state==='configured'&&!d.roulette.incomplete;
 cards.append(
 readinessCard('SOOP 방송 계정',connected?'연결 정보 있음':d.connection.state==='unknown'?'조회하지 못함':'연결 확인 필요',connected?'계정이 연결되어 있습니다. 방송 중 수집이 안 되면 마이페이지에서 연결 자가진단을 실행하세요.':'마이페이지에서 연결 상태를 확인하고 필요한 경우 다시 연결하세요.','/dashboard#account','방송 계정 확인',connected),
 readinessCard('풍벽지 프로그램',online?'최근 연결 확인':d.agent.state==='unknown'?'조회하지 못함':d.agent.state==='missing'?'연결된 프로그램 없음':'최근 연결 확인 안 됨',online?'최근 2분 이내 프로그램의 응답을 받았습니다. 실제 화면 표시는 방송 PC에서 확인하세요.':'방송 PC에서 별록 풍벽지를 실행하고 같은 계정으로 로그인하세요. 재연결 후 상태를 새로고침해주세요.','#broadcastReadiness',online?'설치·표시 안내 보기':'프로그램 설치·연결 안내',online),
 readinessCard('룰렛 설정',configured?'활성 룰렛 '+d.roulette.active+(d.roulette.more?'개 이상':'개'):d.roulette.state==='unknown'?'조회하지 못함':d.roulette.incomplete?'회전 수 확인 필요':'활성 룰렛 없음',configured?'저장한 후원 범위와 회전 수를 방송 설정과 비교해주세요.':'룰렛을 사용하는 방송만 설정이 필요합니다. 일반 후원 수집을 위해 룰렛을 만들 필요는 없습니다.','/dashboard/roulette-rules','룰렛 설정 확인',configured),
 readinessCard('방송 채팅 수집',d.collection.state==='connected'?'최근 연결 확인':d.collection.state==='unknown'?'조회하지 못함':'방송 시작 후 확인',d.collection.state==='connected'?'채팅 연결이 확인됐습니다. 실제 후원 저장 여부는 후원 내역에서 확인하세요.':'방송이 꺼져 있으면 연결되지 않을 수 있습니다. 방송 중이라면 계정 연결과 후원 내역을 확인하세요.','/dashboard#history','후원 내역 확인',d.collection.state==='connected')
 );cards.children[1].querySelector('a').href='#wallpaperInstall';
 status.textContent=new Date(d.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' (한국 시간) 확인 · 상태가 바뀌면 새로고침해주세요.';
 }catch{status.textContent='상태를 확인하지 못했습니다. 잠시 후 새로고침해주세요. 아래 안내는 계속 이용할 수 있습니다.'}
 finally{readinessBusy=false;readinessAfter=Date.now()+3000;setTimeout(()=>{button.disabled=false},3000)}
}
document.querySelector('[data-step=agent]').closest('section').id='wallpaperInstall';
document.getElementById('refreshReadiness').onclick=refreshReadiness;
document.getElementById('copyOverlayUrl').onclick=async()=>{const status=document.getElementById('copyOverlayStatus');try{await navigator.clipboard.writeText(document.getElementById('overlayUrl').textContent);status.textContent='복사했습니다. 방송 PC의 브라우저 소스에 붙여넣으세요.'}catch{status.textContent='자동 복사가 안 됩니다. 위 주소를 길게 누르거나 선택해서 복사해주세요.'}};
void refreshReadiness();
