const box=document.getElementById('statusBox'),refreshBtn=document.getElementById('refreshBtn');
function getToken(){const hash=location.hash.slice(1).trim();if(hash){localStorage.setItem('byeollog_signup_status_token',hash);history.replaceState(null,'',location.pathname)}return hash||localStorage.getItem('byeollog_signup_status_token')||''}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(a){
  if(a.status==='approved'){box.innerHTML='<span class="badge approved">승인 완료</span><div class="title">가입이 승인되었습니다</div><div class="desc">등록한 이메일로 전송된 계정 설정 안내를 확인해 비밀번호를 설정해주세요. 메일이 보이지 않으면 관리자에게 재발송을 요청해주세요.</div>';return}
  if(a.status==='rejected'){box.innerHTML='<span class="badge rejected">승인되지 않음</span><div class="title">가입 신청이 승인되지 않았습니다</div><div class="desc">자세한 내용은 아래 사유를 확인해주세요.</div>'+(a.rejection_reason?'<div class="reason">'+esc(a.rejection_reason)+'</div>':'');return}
  box.innerHTML='<span class="badge pending">승인 대기 중</span><div class="title">관리자가 신청을 확인하고 있습니다</div><div class="desc">승인 여부는 이 화면에서 언제든 다시 확인할 수 있습니다. 승인 후 계정 설정 안내가 등록한 이메일로 발송됩니다.</div>';
}
async function load(){const token=getToken();if(!token){box.innerHTML='<div class="error">이 브라우저에 저장된 가입 신청 정보가 없습니다.<br>기존 신청자는 가입 신청 화면에 동일 이메일과 SOOP ID를 다시 입력하면 상태 링크를 발급받을 수 있습니다.</div>';refreshBtn.disabled=true;return}refreshBtn.disabled=true;refreshBtn.textContent='확인 중...';try{const r=await fetch('/api/login?operation=signup-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'가입 상태 확인 실패');render(j.application||{})}catch(e){box.innerHTML='<div class="error">'+esc(e.message)+'</div>'}finally{refreshBtn.disabled=false;refreshBtn.textContent='상태 새로고침'}}
refreshBtn.addEventListener('click',load);load();
