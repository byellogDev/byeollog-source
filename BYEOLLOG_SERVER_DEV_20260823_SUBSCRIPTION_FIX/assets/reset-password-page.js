const $=id=>document.getElementById(id);
const hash=new URLSearchParams(location.hash.slice(1));
const accessToken=hash.get('access_token')||'';

function passwordPolicyMessage(password){
  if(password.length<10)return '새 비밀번호는 10자 이상이어야 합니다.';
  if(password.length>128)return '새 비밀번호는 128자 이하여야 합니다.';
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>/?`~\\]/.test(password))return '영문 대문자·소문자·숫자·특수문자를 각각 포함해주세요.';
  return '';
}

if(accessToken){$('requestForm').classList.add('hidden');$('confirmForm').classList.remove('hidden');history.replaceState(null,'',location.pathname)}

async function call(operation,body){
  const response=await fetch('/api/login?operation='+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.message||'요청을 처리하지 못했습니다.');
  return result;
}

$('requestForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter||event.currentTarget.querySelector('button[type="submit"]'),message=$('msg');
  button.disabled=true;message.className='msg';message.textContent='메일 발송 요청 중...';
  try{const result=await call('request-reset',{email:$('email').value});message.className='msg ok';message.textContent=result.message}
  catch(error){message.textContent=error.message}
  finally{button.disabled=false}
});

$('confirmForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter||event.currentTarget.querySelector('button[type="submit"]'),message=$('msg'),password=$('password').value;
  if(password!==$('passwordConfirm').value){message.textContent='새 비밀번호가 일치하지 않습니다.';return}
  const policyMessage=passwordPolicyMessage(password);
  if(policyMessage){message.textContent=policyMessage;return}
  button.disabled=true;message.className='msg';message.textContent='비밀번호 변경 중...';
  try{const result=await call('confirm-reset',{access_token:accessToken,password});message.className='msg ok';message.textContent=result.message;$('confirmForm').classList.add('hidden')}
  catch(error){message.textContent=error.message}
  finally{button.disabled=false}
});
