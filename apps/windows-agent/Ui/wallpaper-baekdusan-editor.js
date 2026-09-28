const {state,request,initializeWallpaperEditor,renderWallpaper,flushWallpaperEdits,status}=globalThis.wallpaperBaekdusanBridge;
// Runs after wallpaper_editor.html's existing request bridge and state.
let baekDialog=null,baekBusy=false;
function baekElement(tag,text){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
function baekField(parent,label,value,type='number'){
  const wrap=baekElement('label'),caption=baekElement('span',label),input=baekElement('input');
  Object.assign(wrap.style,{display:'grid',gap:'6px',fontSize:'15px'});
  input.type=type;input.value=String(value);Object.assign(input.style,{padding:'10px',fontSize:'16px',border:'1px solid #90a4bb',borderRadius:'8px',width:'100%',boxSizing:'border-box'});
  wrap.append(caption,input);parent.append(wrap);return input;
}
function baekMessage(message){const el=document.getElementById('baekMessage');if(el)el.textContent=message;else status('wallpaperStatus',message,'error');}
function baekOpen(title){
  baekDialog?.remove();baekDialog=baekElement('dialog');
  Object.assign(baekDialog.style,{width:'min(780px,90vw)',maxHeight:'85vh',overflow:'auto',padding:'24px',border:'1px solid #6482a4',borderRadius:'18px',background:'#102746',color:'#fff'});
  const heading=baekElement('h2',title),close=baekElement('button','닫기');close.type='button';close.onclick=()=>{if(!baekBusy){baekDialog.close();baekDialog.remove();baekDialog=null;}};
  const head=baekElement('div');Object.assign(head.style,{display:'flex',justifyContent:'space-between',alignItems:'center'});head.append(heading,close);
  const message=baekElement('p');message.id='baekMessage';message.setAttribute('role','status');message.style.color='#ffdb8e';
  baekDialog.append(head,message);baekDialog.addEventListener('cancel',e=>{if(baekBusy)e.preventDefault();});document.body.append(baekDialog);baekDialog.showModal();return baekDialog;
}
async function baekControl(body){return request('wallpaper-control',{method:'POST',body:JSON.stringify(body)});}
async function baekMutate(body){
  if(baekBusy)return;baekBusy=true;baekMessage('저장하는 중입니다…');
  try{
    if(!await flushWallpaperEdits())throw new Error('진행 중인 풍벽지 배치 저장을 먼저 완료해주세요.');
    const next=await baekControl(body);state.wallpaper=next;initializeWallpaperEditor();renderWallpaper();
    baekDialog?.close();baekDialog?.remove();baekDialog=null;
    status('wallpaperStatus',body.action==='baekdusan-remove'?'백두산 묶기를 해제했습니다. 기존 표시 설정으로 돌아갑니다.':'백두산을 저장했습니다. 이후 후원도 자동으로 확인합니다.','ok');
  }catch(error){baekMessage(error.message);renderWallpaper();}finally{baekBusy=false;}
}
function editBaekdusan(run,position){
  if(position){void baekMutate({action:"baekdusan-layout",id:run.id,x:position.x,y:position.y,width:run.width,height:run.height,columns:run.columns});return;}
  const dialog=baekOpen('백두산 배치·관리');
  dialog.append(baekElement('p',`${run.start} → ${run.target} · ${run.members.length}칸 채움 · 시작: ${run.members[0].actorName} / ${new Date(run.members[0].receivedAt).toLocaleString('ko-KR')}`));
  const form=baekElement('div');Object.assign(form.style,{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'14px'});dialog.append(form);
  const x=baekField(form,'왼쪽 위치 (0~1920)',run.x),y=baekField(form,'위쪽 위치 (0~1080)',run.y);
  const width=baekField(form,'영역 너비',run.width),height=baekField(form,'영역 높이',run.height),columns=baekField(form,'한 줄 칸 수 (1~25)',run.columns);
  const save=baekElement('button','배치 저장'),remove=baekElement('button','백두산 묶기 해제');save.className='primary';remove.className='danger';
  save.onclick=()=>baekMutate({action:'baekdusan-layout',id:run.id,x:Number(x.value),y:Number(y.value),width:Number(width.value),height:Number(height.value),columns:Number(columns.value)});
  remove.onclick=()=>{if(baekBusy)return;const confirmation=baekElement('div');confirmation.append(baekElement('p','묶기를 해제해도 원본 후원 기록은 유지됩니다. 해제할까요?'));const yes=baekElement('button','해제하기');yes.onclick=()=>baekMutate({action:'baekdusan-remove',id:run.id});confirmation.append(yes);remove.disabled=true;dialog.append(confirmation);};
  const actions=baekElement('div');Object.assign(actions.style,{display:'flex',gap:'10px',marginTop:'20px'});actions.append(save,remove);dialog.append(actions);
}
function openBaekdusan(){
  const dialog=baekOpen('백두산 만들기');
  dialog.append(baekElement('p','시작 별풍선을 직접 선택하세요. 그 후 다음 숫자가 처음 들어올 때마다 한 칸씩 채웁니다. 후원자는 달라도 됩니다.'));
  dialog.append(baekElement('p','이 PC에 계정별로 저장됩니다. 보관 중인 방송 기록(최근 7일)에서 시작할 수 있고, 방송당 하나·묶음당 최대 500칸입니다.'));
  for(const run of state.wallpaper?.baekdusan?.runs||[]){const manage=baekElement('button',`${run.start}~${run.target} · ${run.members.length}칸 · 관리`);manage.onclick=()=>editBaekdusan(run);dialog.append(manage);}
  if(state.wallpaper?.baekdusan?.error)baekMessage(state.wallpaper.baekdusan.error);
  const label=baekElement('label','방송 선택'),select=baekElement('select');Object.assign(select.style,{display:'block',width:'100%',padding:'12px',fontSize:'16px',margin:'12px 0'});
  for(const session of state.wallpaper?.sessions||[]){const option=baekElement('option',`${new Date(session.startedAt||session.started_at).toLocaleString('ko-KR')} · ${session.label||'방송'}`);option.value=session.id;select.append(option);}select.value=(state.wallpaper?.selectedSessionIds||[])[0]||select.value;label.append(select);dialog.append(label);dialog.append(baekElement('p','백두산은 화면 표시 회차로 선택한 방송에서만 보입니다. 다른 방송을 고르면 회차 선택도 확인해주세요.'));
  const startAmount=baekField(dialog,'찾을 시작 별풍선 수량',1);
  const load=baekElement('button','시작 후원 찾기'),list=baekElement('div'),more=baekElement('button','다음 후원 보기'),target=baekField(dialog,'몇 개까지 진행할까요? (목표 숫자)',100),create=baekElement('button','선택한 후원으로 백두산 만들기');
  Object.assign(list.style,{display:'grid',gap:'6px',maxHeight:'260px',overflow:'auto',margin:'12px 0'});create.className='primary';create.disabled=true;more.hidden=true;
  let cursor=0,chosen=null,generation=0,loading=false;
  const reset=()=>{generation++;cursor=0;chosen=null;create.disabled=true;more.hidden=true;list.replaceChildren();};select.onchange=reset;startAmount.oninput=reset;
  async function fetchPage(first){
    if(loading)return;if(first)reset();const ticket=generation;loading=true;load.disabled=true;more.disabled=true;
    try{baekMessage('후원 기록을 불러오는 중입니다…');const amount=Number(startAmount.value);if(!Number.isSafeInteger(amount)||amount<1)throw new Error('시작 수량을 입력해주세요.');
      const response=await baekControl({action:'baekdusan-log',sessionId:select.value,amount,afterSequence:cursor});if(ticket!==generation||!dialog.isConnected)return;
      for(const tip of response.tiles){const button=baekElement('button',`${new Date(tip.receivedAt).toLocaleString('ko-KR')} · ${tip.actorName} · ${tip.amount}개`);button.style.textAlign='left';button.onclick=()=>{chosen=tip;for(const row of list.children)row.classList.remove('primary');button.classList.add('primary');create.disabled=false;};list.append(button);}
      cursor=response.nextSequence;more.hidden=!response.hasMore;baekMessage(list.children.length?'백두산이 시작된 후원을 선택해주세요.':'해당 수량의 후원 기록이 없습니다.');
    }catch(error){if(ticket===generation)baekMessage(error.message);}finally{loading=false;load.disabled=false;more.disabled=false;}
  }
  load.onclick=()=>fetchPage(true);more.onclick=()=>fetchPage(false);
  create.onclick=()=>{if(!chosen)return;const number=Number(target.value);if(!Number.isSafeInteger(number)||number<chosen.amount||number-chosen.amount>=500){baekMessage('목표는 시작 숫자 이상, 최대 500칸까지 입력해주세요.');return;}void baekMutate({action:'baekdusan-create',sessionId:chosen.sessionId,tileId:chosen.id,target:number});};
  dialog.append(load,list,more,create);
}
document.getElementById('openBaekdusanBtn').onclick=openBaekdusan;
