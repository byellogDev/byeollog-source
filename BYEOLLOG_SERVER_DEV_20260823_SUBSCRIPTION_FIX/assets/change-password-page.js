const $=id=>document.getElementById(id);

(async()=>{
  try{
    const response=await fetch('/api/admin?operation=context',{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});
    if(response.status===401){location.replace('/login?expired=1');return}
    if(response.status===503)location.replace('/login?check=retry');
  }catch{}
})();

function passwordPolicyMessage(password){
  if(password.length<10)return '새 비밀번호는 10자 이상이어야 합니다.';
  if(password.length>128)return '새 비밀번호는 128자 이하여야 합니다.';
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>/?`~\\]/.test(password))return '영문 대문자·소문자·숫자·특수문자를 각각 포함해주세요.';
  return '';
}

$('form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter||event.currentTarget.querySelector('button[type="submit"]'),message=$('msg'),password=$('password').value;
  if(password!==$('confirm').value){message.className='msg';message.textContent='새 비밀번호가 일치하지 않습니다.';return}
  const policyMessage=passwordPolicyMessage(password);
  if(policyMessage){message.className='msg';message.textContent=policyMessage;return}
  button.disabled=true;message.className='msg';message.textContent='비밀번호 변경 중...';
  try{
    const response=await fetch('/api/login?operation=change',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current_password:$('current').value,password})});
    const body=await response.json().catch(()=>({}));
    if(response.status===401&&String(body.message||'').includes('세션')){location.replace('/login?expired=1');return}
    if(!response.ok)throw new Error(body.message||'비밀번호를 변경하지 못했습니다.');
    message.className='msg ok';message.textContent=body.message||'변경되었습니다. 다시 로그인해 주세요.';
    setTimeout(()=>location.replace('/login'),1200);
  }catch(error){message.className='msg';message.textContent=error.message||'변경에 실패했습니다.'}
  finally{button.disabled=false}
});
