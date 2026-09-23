const $=id=>document.getElementById(id);
const referrerSearch=$('referrerSearch');
const referrerResults=$('referrerResults');
const referrerSelected=$('referrerSelected');
let selectedReferrer=null;
let searchTimer=null;
let searchController=null;
let soopConnected=false;
let soopAlreadyRegistered=new URLSearchParams(location.search).get('soop')==='already-registered';
let connectionChecking=true;
let submitting=false;
let activeReferrer=-1;
const draftKey='byeollog_signup_draft_v2';

function updateSubmitState(){
  $('submitBtn').disabled=!soopConnected||connectionChecking||submitting;
  $('soopConnectButton').disabled=connectionChecking||submitting;
  $('soopConnectButton').hidden=soopConnected||soopAlreadyRegistered;
  $('submitBtn').textContent=submitting?'가입 중…':'가입하기';
  for(const section of [$('profileSection'),$('consentSection')]){
    section.classList.toggle('signupBlocked',soopAlreadyRegistered);
    section.setAttribute('aria-disabled',String(soopAlreadyRegistered));
    for(const control of section.querySelectorAll('input,button,select'))control.disabled=soopAlreadyRegistered||submitting;
  }
  $('signupNextStep').textContent=connectionChecking?'SOOP 연결 상태를 확인하고 있습니다.':soopAlreadyRegistered?'이미 가입된 SOOP 계정입니다. 기존 별록 계정으로 로그인해주세요.':!soopConnected?'먼저 위의 SOOP 계정 연결을 완료해주세요.':'필수 정보를 입력하고 약관에 동의하면 가입할 수 있습니다.';
}

function showError(message,target=$('msg')){
  const msg=$('msg');msg.className='msg error';msg.textContent=message;
  target.focus({preventScroll:true});target.scrollIntoView({block:'center',behavior:'auto'});
}

function setActiveReferrer(index){
  const options=[...referrerResults.querySelectorAll('[role=option]')];
  activeReferrer=index;
  options.forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));
  if(options[index]){referrerSearch.setAttribute('aria-activedescendant',options[index].id);options[index].scrollIntoView({block:'nearest'})}
  else referrerSearch.removeAttribute('aria-activedescendant');
}

function closeReferrerResults(){
  referrerResults.hidden=true;
  referrerSearch.setAttribute('aria-expanded','false');
  setActiveReferrer(-1);
}

function clearReferrerSelection({keepText=false}={}){
  selectedReferrer=null;
  referrerSearch.readOnly=false;
  if(!keepText)referrerSearch.value='';
  $('referrerSelectedName').textContent='';
  referrerSelected.hidden=true;
  closeReferrerResults();
  $('referrerStatus').textContent='';
}

function chooseReferrer(streamer){
  clearTimeout(searchTimer);searchController?.abort();
  selectedReferrer=streamer;
  referrerSearch.value=streamer.name;
  referrerSearch.readOnly=true;
  $('referrerSelectedName').textContent=streamer.name;
  referrerSelected.hidden=false;
  closeReferrerResults();
  $('referrerStatus').textContent=streamer.name+'님을 추천인으로 선택했습니다.';
  referrerSearch.removeAttribute('aria-invalid');
}

function renderReferrerResults(streamers,message=''){
  activeReferrer=-1;referrerSearch.removeAttribute('aria-activedescendant');
  referrerResults.replaceChildren();
  if(message||!streamers.length){
    const empty=document.createElement('div');
    empty.className='referralEmpty';
    empty.textContent=message||'일치하는 가입 스트리머가 없습니다.';
    referrerResults.append(empty);
  }else{
    for(const streamer of streamers){
      const button=document.createElement('button');
      button.type='button';
      button.className='referralResult';
      button.setAttribute('role','option');
      button.id='referrerOption'+referrerResults.children.length;
      button.tabIndex=-1;button.setAttribute('aria-selected','false');
      const name=document.createElement('span');
      name.textContent=streamer.name;
      const action=document.createElement('small');
      action.textContent='추천인으로 선택';
      button.append(name,action);
      button.addEventListener('click',()=>chooseReferrer(streamer));
      button.addEventListener('mousedown',event=>event.preventDefault());
      referrerResults.append(button);
    }
  }
  referrerResults.hidden=false;
  referrerSearch.setAttribute('aria-expanded','true');
  $('referrerStatus').textContent=message||(!streamers.length?'일치하는 가입 스트리머가 없습니다.':streamers.length+'명 검색됨. 위아래 방향키로 이동하고 Enter로 선택하세요.');
}

async function searchReferrers(query){
  searchController?.abort();
  const controller=new AbortController();
  searchController=controller;
  $('referrerStatus').textContent='추천 스트리머를 검색하고 있습니다.';
  try{
    const response=await fetch('/api/login?operation=referrer-search',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query}),
      signal:controller.signal
    });
    const payload=await response.json().catch(()=>({}));
    if(controller.signal.aborted||referrerSearch.value.trim()!==query)return;
    if(!response.ok)throw new Error(payload.message||'추천 스트리머 검색 실패');
    renderReferrerResults(Array.isArray(payload.streamers)?payload.streamers:[]);
  }catch(error){
    if(error.name!=='AbortError'&&referrerSearch.value.trim()===query){
      renderReferrerResults([],error.message||'추천 스트리머를 검색하지 못했습니다.');
    }
  }
}

referrerSearch.addEventListener('input',()=>{
  if(selectedReferrer)clearReferrerSelection({keepText:true});
  clearTimeout(searchTimer);
  searchController?.abort();
  closeReferrerResults();
  const query=referrerSearch.value.trim();
  $('referrerStatus').textContent='';
  if(query.length<2)return;
  searchTimer=setTimeout(()=>searchReferrers(query),250);
});
referrerSearch.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'||event.key==='Tab'){
    clearTimeout(searchTimer);searchController?.abort();closeReferrerResults();
    if(event.key==='Escape')event.preventDefault();return;
  }
  const options=[...referrerResults.querySelectorAll('[role=option]')];
  if(referrerResults.hidden||!options.length)return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    setActiveReferrer(activeReferrer<0?(event.key==='ArrowDown'?0:options.length-1):(activeReferrer+(event.key==='ArrowDown'?1:options.length-1))%options.length);
  }else if(event.key==='Enter'){
    event.preventDefault();if(activeReferrer>=0)options[activeReferrer].click();
  }
});
$('clearReferrer').addEventListener('click',()=>{clearReferrerSelection();referrerSearch.focus()});
document.addEventListener('click',event=>{if(!event.target.closest('.referralWrap')){clearTimeout(searchTimer);searchController?.abort();closeReferrerResults()}});

function saveDraft(){
  try{sessionStorage.setItem(draftKey,JSON.stringify({
    email:$('email').value,streamerName:$('streamerName').value,
    referrer:selectedReferrer,agreeTerms:$('agreeTerms').checked,agreeCollect:$('agreeCollect').checked,agreeAge:$('agreeAge').checked,consentVersion:'2026-09-14'
  }));}catch{/* Storage may be disabled; account connection must remain usable. */}
}

function restoreDraft(){
  try{
    const draft=JSON.parse(sessionStorage.getItem(draftKey)||'null');
    if(!draft||typeof draft!=='object')return;
    $('email').value=String(draft.email||'');$('streamerName').value=String(draft.streamerName||'');
    $('agreeTerms').checked=draft.consentVersion==='2026-09-14'&&draft.agreeTerms===true;$('agreeCollect').checked=draft.consentVersion==='2026-09-14'&&draft.agreeCollect===true;$('agreeAge').checked=draft.consentVersion==='2026-09-14'&&draft.agreeAge===true;
    if(draft.referrer?.key&&draft.referrer?.name)chooseReferrer({key:String(draft.referrer.key),name:String(draft.referrer.name)});
  }catch{try{sessionStorage.removeItem(draftKey)}catch{}}
}

async function refreshSoopConnection(){
  const box=$('soopConnection'),title=$('soopConnectionTitle'),detail=$('soopConnectionDetail'),button=$('soopConnectButton'),login=$('existingAccountLogin');
  connectionChecking=true;button.disabled=true;box.setAttribute('aria-busy','true');updateSubmitState();
  try{
    const response=await fetch('/api/auth/soop/signup/status',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.message||'SOOP 연결 상태 확인 실패');
    soopAlreadyRegistered=soopAlreadyRegistered||payload.registered===true||payload.code==='soop_account_already_registered';
    soopConnected=payload.connected===true&&!soopAlreadyRegistered;
    box.classList.remove('connectionError');
    box.classList.toggle('connected',soopConnected);
    box.classList.toggle('connectionError',soopAlreadyRegistered);
    title.textContent=soopAlreadyRegistered?'이미 별록에 연결된 SOOP 계정입니다':soopConnected?'SOOP 계정 연결 완료':'SOOP 계정 연결 필요';
    detail.textContent=soopAlreadyRegistered?'기존 별록 계정으로 로그인해주세요.':soopConnected?`연결된 SOOP ID: ${payload.soopId}`:'가입할 스트리머 본인의 SOOP 계정으로 로그인해주세요.';
    button.textContent='SOOP 계정 연결하기';
    login.hidden=!soopAlreadyRegistered;
  }catch(error){
    soopConnected=false;soopAlreadyRegistered=false;login.hidden=true;box.classList.remove('connected');box.classList.add('connectionError');title.textContent='SOOP 연결 상태 확인 실패';detail.textContent=error.name==='TimeoutError'?'연결 확인이 지연되고 있습니다. 다시 연결해주세요.':error.message;
    button.textContent='SOOP 계정 연결 다시 시도';
  }finally{connectionChecking=false;button.disabled=false;box.setAttribute('aria-busy','false');updateSubmitState()}
  return soopConnected;
}

function startSoopConnection(){
  if(submitting||connectionChecking)return;
  saveDraft();
  if(!soopConnected&&!soopAlreadyRegistered){location.assign('/api/auth/soop/signup/start');return}
  if(soopAlreadyRegistered){$('existingAccountLogin').focus();return}
}

$('soopConnectButton').addEventListener('click',startSoopConnection);
$('signupForm').addEventListener('invalid',event=>event.target.setAttribute('aria-invalid','true'),true);
$('signupForm').addEventListener('input',event=>{event.target.removeAttribute('aria-invalid');$('msg').textContent=''});
$('signupForm').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('msg');msg.className='msg';msg.textContent='';
  if(submitting||connectionChecking)return;
  if(!soopConnected){showError('먼저 본인 SOOP 계정을 연결해주세요.',$('soopConnectButton'));return}
  if(referrerSearch.value.trim()&&!selectedReferrer){referrerSearch.setAttribute('aria-invalid','true');showError('검색 결과에서 추천한 스트리머를 선택하거나 입력을 비워주세요.',referrerSearch);return}
  if(!$('agreeTerms').checked||!$('agreeCollect').checked){showError('약관 및 개인정보 수집·이용에 동의해 주세요.',!$('agreeTerms').checked?$('agreeTerms'):$('agreeCollect'));return}
  if(!$('agreeAge').checked){showError('만 14세 이상인지 확인해주세요.',$('agreeAge'));return}
  submitting=true;updateSubmitState();
  try{
    if(!await refreshSoopConnection()){showError('SOOP 연결을 다시 확인해주세요. 입력한 정보는 유지됩니다.',$('soopConnectButton'));return}
    const r=await fetch('/api/login?operation=signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,streamer_name:$('streamerName').value,referrer_workspace_slug:selectedReferrer?.key||'',consents:{termsVersion:'2026-09-14',privacyVersion:'2026-09-14',termsAgreed:$('agreeTerms').checked,collectionAgreed:$('agreeCollect').checked,age14Confirmed:$('agreeAge').checked}})});
    const j=await r.json().catch(()=>({}));
    if(j.code==='soop_signup_connection_required'){
      soopConnected=false;$('soopConnection').classList.remove('connected');$('soopConnection').classList.add('connectionError');
      $('soopConnectionTitle').textContent='SOOP 계정을 다시 연결해주세요.';$('soopConnectionDetail').textContent='연결이 만료되었습니다. 입력한 정보는 유지됩니다.';
      $('soopConnectButton').textContent='SOOP 계정 다시 연결하기';showError('SOOP 계정을 다시 연결한 뒤 가입해주세요.',$('soopConnectButton'));return;
    }
    if(j.code==='soop_account_already_registered'){
      soopConnected=false;soopAlreadyRegistered=true;$('soopConnection').classList.remove('connected');$('soopConnection').classList.add('connectionError');
      $('soopConnectionTitle').textContent='이미 별록에 연결된 SOOP 계정입니다';$('soopConnectionDetail').textContent='기존 별록 계정으로 로그인해주세요.';
      $('existingAccountLogin').hidden=false;updateSubmitState();showError(j.message,$('existingAccountLogin'));return;
    }
    if(!r.ok)throw new Error(j.message||'가입 신청 실패');
    try{sessionStorage.removeItem(draftKey)}catch{}
    if(!j.password_setup_email_sent)$('doneDescription').innerHTML='가입은 완료되었지만 비밀번호 설정 메일 발송이 지연되고 있습니다.<br>로그인 화면의 비밀번호 찾기에서 설정 메일을 다시 요청해주세요.';
    $('doneEmail').textContent=$('email').value.trim();$('formArea').hidden=true;$('doneArea').hidden=false;
    $('doneTitle').focus();
  }catch(err){showError(err.message||'가입을 완료하지 못했습니다. 다시 시도해주세요.')}
  finally{submitting=false;updateSubmitState();if(!soopConnected)$('soopConnectButton').focus()}
});

restoreDraft();
refreshSoopConnection();
