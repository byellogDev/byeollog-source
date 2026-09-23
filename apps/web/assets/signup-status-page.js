const box=document.getElementById('statusBox'),refreshBtn=document.getElementById('refreshBtn');
function getToken(){const hash=location.hash.slice(1).trim();if(hash){localStorage.setItem('byeollog_signup_status_token',hash);history.replaceState(null,'',location.pathname)}return hash||localStorage.getItem('byeollog_signup_status_token')||''}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(a){
  if(a.status==='approved'){box.innerHTML='<span class="badge approved">가입 완료</span><div class="title">기존 가입이 완료된 계정입니다</div><div class="desc">등록한 이메일로 로그인하거나 비밀번호 찾기를 이용해주세요.</div>';return}
  if(a.status==='rejected'){box.innerHTML='<span class="badge rejected">이전 기록</span><div class="title">이전 가입 절차는 종료되었습니다</div><div class="desc">SOOP 계정을 연결하는 새 가입 화면을 이용해주세요.</div>'+(a.rejection_reason?'<div class="reason">'+esc(a.rejection_reason)+'</div>':'');return}
  box.innerHTML='<span class="badge pending">이전 기록</span><div class="title">관리자 승인 방식이 종료되었습니다</div><div class="desc">SOOP 계정을 연결하는 새 가입 화면에서 바로 가입을 완료해주세요.</div>';
}
async function load(){const token=getToken();if(!token){box.innerHTML='<div class="error">이 브라우저에 저장된 이전 가입 기록이 없습니다.<br>SOOP 계정을 연결하는 새 가입 화면을 이용해주세요.</div>';refreshBtn.disabled=true;return}refreshBtn.disabled=true;refreshBtn.textContent='확인 중...';try{const r=await fetch('/api/login?operation=signup-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'가입 기록 확인 실패');render(j.application||{})}catch(e){box.innerHTML='<div class="error">'+esc(e.message)+'</div>'}finally{refreshBtn.disabled=false;refreshBtn.textContent='기록 새로고침'}}
refreshBtn.addEventListener('click',load);load();
