const loginParams=new URLSearchParams(location.search);
(function(){
  let handoffCode=loginParams.get('handoff')||'';
  if(!handoffCode){try{handoffCode=sessionStorage.getItem('byeollog_handoff_code')||''}catch(_){}}
  if(!handoffCode)return;
  try{sessionStorage.setItem('byeollog_handoff_code',handoffCode)}catch(_){}
  try{history.replaceState(null,'','/login')}catch(_){}
  try{if(location.hash&&location.hash.toLowerCase().includes('handoff'))history.replaceState(null,'','/login')}catch(_){}
  const form=document.getElementById('loginForm'),msg=document.getElementById('msg');
  form.querySelectorAll('input,button').forEach(el=>el.disabled=true);
  msg.textContent='Collector 계정으로 대시보드를 여는 중...';
  fetch('/api/login?operation=handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:handoffCode}),cache:'no-store',credentials:'same-origin'})
    .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'자동 로그인 실패');try{sessionStorage.removeItem('byeollog_handoff_code')}catch(_){}location.replace('/dashboard')})
    .catch(err=>{try{sessionStorage.removeItem('byeollog_handoff_code')}catch(_){}try{history.replaceState(null,'','/login')}catch(_){}form.querySelectorAll('input,button').forEach(el=>el.disabled=false);msg.textContent=err.message+' 직접 로그인해주세요.'});
})();
if(loginParams.get('expired')==='1')document.getElementById('msg').textContent='관리자 세션이 만료되었습니다. 다시 로그인해주세요.';
document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const msg=document.getElementById('msg');msg.textContent='확인 중...';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:document.getElementById('loginId').value,password:document.getElementById('password').value})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'로그인 실패');location.replace('/dashboard')}
  catch(err){msg.textContent=err.message}
});
