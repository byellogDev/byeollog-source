const loginParams=new URLSearchParams(location.search);
(function(){
  const handoffHash=new URLSearchParams(location.hash.replace(/^#/,''));
  // New links use the fragment so the code never reaches the HTTP request line.
  // Keep query parsing temporarily so an already-issued legacy link can finish.
  const agentHandoff=handoffHash.get('agent_handoff')||'';
  const handoffCode=agentHandoff||handoffHash.get('handoff')||loginParams.get('handoff')||'';
  if(!handoffCode)return;
  // Remove the bearer value before any network request or user-visible work.
  try{history.replaceState(null,'','/login')}catch(_){}
  const form=document.getElementById('loginForm'),msg=document.getElementById('msg');
  form.querySelectorAll('input,button').forEach(el=>el.disabled=true);
  msg.textContent='별록 계정으로 대시보드를 여는 중...';
  fetch(agentHandoff?'/api/login?operation=agent-dashboard-login':'/api/login?operation=handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:handoffCode}),cache:'no-store',credentials:'same-origin'})
    .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'자동 로그인 실패');location.replace('/dashboard')})
    .catch(err=>{try{history.replaceState(null,'','/login')}catch(_){}form.querySelectorAll('input,button').forEach(el=>el.disabled=false);msg.textContent=err.message+' 직접 로그인해주세요.'});
})();
if(loginParams.get('expired')==='1')document.getElementById('msg').textContent='관리자 세션이 만료되었습니다. 다시 로그인해주세요.';
if(loginParams.get('check')==='retry')document.getElementById('msg').textContent='로그인 상태 확인이 잠시 지연되고 있습니다. 잠시 후 다시 로그인해주세요.';
document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const msg=document.getElementById('msg');msg.textContent='확인 중...';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:document.getElementById('loginId').value,password:document.getElementById('password').value})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'로그인 실패');location.replace('/dashboard')}
  catch(err){msg.textContent=err.message}
});
