const CONFIRM_PHRASE='탈퇴합니다';

const form=document.getElementById('withdrawForm');
const input=document.getElementById('withdrawConfirm');
const submit=document.getElementById('withdrawSubmit');
const message=document.getElementById('withdrawMessage');

(async()=>{
  try{
    const response=await fetch('/api/admin?operation=context',{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});
    if(response.status===401){location.replace('/login?expired=1');return}
    if(response.status===503)location.replace('/login?check=retry');
  }catch{}
})();

function setMessage(text,type=''){
  message.textContent=text;
  message.className=`message${type?` ${type}`:''}`;
}

function syncSubmit(){
  submit.disabled=input.value.trim()!==CONFIRM_PHRASE;
}

input.addEventListener('input',syncSubmit);

form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  if(input.value.trim()!==CONFIRM_PHRASE)return;
  submit.disabled=true;
  input.disabled=true;
  setMessage('탈퇴를 처리하고 있습니다. 창을 닫지 마세요.');
  try{
    const response=await fetch('/api/admin?operation=withdraw',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      credentials:'same-origin',
      body:JSON.stringify({confirm:CONFIRM_PHRASE})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      if(response.status===401){
        location.replace('/login?expired=1');
        return;
      }else{
        setMessage(String(data.message||'회원 탈퇴를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.'),'error');
      }
      return;
    }
    setMessage('회원 탈퇴가 완료되었습니다. 로그인 화면으로 이동합니다.','success');
    setTimeout(()=>location.replace('/login?withdrawn=1'),900);
  }catch{
    setMessage('네트워크 오류로 회원 탈퇴를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.','error');
  }finally{
    if(!message.classList.contains('success')){
      input.disabled=false;
      syncSubmit();
      input.focus();
    }
  }
});

syncSubmit();
