const $=id=>document.getElementById(id);
$('soopId').addEventListener('input',()=>{const id=$('soopId').value.trim().toLowerCase();$('stationUrl').value=id?'https://ch.sooplive.co.kr/'+encodeURIComponent(id):''});
$('signupForm').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('msg'),btn=$('submitBtn');msg.className='msg';msg.textContent='';
  if(!$('agreeTerms').checked||!$('agreeCollect').checked){msg.className='msg error';msg.textContent='약관 및 개인정보 수집·이용에 동의해 주세요.';return}
  btn.disabled=true;btn.textContent='신청 중...';
  try{
    const r=await fetch('/api/login?operation=signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,streamer_name:$('streamerName').value,soop_id:$('soopId').value,verification_channel:'',verification_account:'',note:$('note').value})});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'가입 신청 실패');
    if(j.status_token){localStorage.setItem('byeollog_signup_status_token',j.status_token);$('statusLink').href='/signup-status#'+j.status_token}
    if(j.recovered_status_link){$('doneTitle').textContent='상태 확인 링크 발급 완료';$('doneDescription').innerHTML='기존 가입 신청을 확인했습니다.<br>아래 버튼에서 현재 승인 상태를 확인할 수 있습니다.'}
    $('formArea').style.display='none';$('doneArea').style.display='block';
  }catch(err){msg.className='msg error';msg.textContent=err.message}
  finally{btn.disabled=false;btn.textContent='가입 신청'}
});
