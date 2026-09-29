const {state,request,initializeWallpaperEditor,renderWallpaper,flushWallpaperEdits,status}=globalThis.wallpaperBaekdusanBridge;
let baekDialog=null,baekBusy=false;
function baekElement(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;if(tag==='button')el.type='button';return el;}
function baekField(parent,label,value){
  const wrap=baekElement('label',undefined,'baek-field'),input=baekElement('input');
  input.type='number';input.value=String(value);input.step='1';wrap.append(baekElement('span',label),input);parent.append(wrap);return input;
}
function baekMessage(message){const el=document.getElementById('baekMessage');if(el)el.textContent=message;else status('wallpaperStatus',message,'error');}
function baekOpen(title){
  baekDialog?.remove();const dialog=baekDialog=baekElement('dialog',undefined,'baek-dialog');
  dialog.setAttribute('aria-labelledby','baekTitle');
  const head=baekElement('header',undefined,'baek-head'),titles=baekElement('div'),heading=baekElement('h2',title),close=baekElement('button','닫기','baek-close');
  heading.id='baekTitle';titles.append(baekElement('span','풍벽지 · 연속 후원','baek-eyebrow'),heading);
  close.onclick=()=>{if(!baekBusy)dialog.close();};head.append(titles,close);
  const body=baekElement('div',undefined,'baek-body'),footer=baekElement('footer',undefined,'baek-footer'),message=baekElement('div',undefined,'baek-status');
  message.id='baekMessage';message.setAttribute('role','status');footer.append(message);dialog.append(head,body,footer);
  dialog.addEventListener('cancel',e=>{if(baekBusy)e.preventDefault();});
  dialog.addEventListener('close',()=>{dialog.remove();if(baekDialog===dialog)baekDialog=null;});
  document.body.append(dialog);dialog.showModal();return {dialog,body,footer};
}
function baekSection(parent,number,title){const section=baekElement('section',undefined,'baek-section'),heading=baekElement('h3');heading.append(baekElement('span',number,'baek-step'),baekElement('span',title));section.append(heading);parent.append(section);return section;}
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
  if(position){void baekMutate({action:'baekdusan-layout',id:run.id,x:position.x,y:position.y,width:run.width,height:run.height,columns:run.columns});return;}
  const {body,footer}=baekOpen('백두산 배치·관리');
  body.append(baekElement('p',run.start+' → '+run.target+' · '+run.members.length+'칸 채움 · 시작: '+run.members[0].actorName+' / '+new Date(run.members[0].receivedAt).toLocaleString('ko-KR'),'baek-intro'));
  const form=baekElement('div',undefined,'baek-fields');body.append(form);
  const x=baekField(form,'왼쪽 위치 (0~1920)',run.x),y=baekField(form,'위쪽 위치 (0~1080)',run.y);
  const width=baekField(form,'영역 너비',run.width),height=baekField(form,'영역 높이',run.height),columns=baekField(form,'한 줄 칸 수 (1~25)',run.columns);
  const save=baekElement('button','배치 저장','baek-primary'),remove=baekElement('button','백두산 묶기 해제','baek-danger');
  save.onclick=()=>baekMutate({action:'baekdusan-layout',id:run.id,x:Number(x.value),y:Number(y.value),width:Number(width.value),height:Number(height.value),columns:Number(columns.value)});
  remove.onclick=()=>{if(baekBusy)return;const confirmation=baekElement('div',undefined,'baek-confirm');confirmation.append(baekElement('p','묶기를 해제해도 원본 후원 기록은 유지됩니다. 해제할까요?'));const yes=baekElement('button','해제하기','baek-danger');yes.onclick=()=>baekMutate({action:'baekdusan-remove',id:run.id});confirmation.append(yes);remove.disabled=true;body.append(confirmation);yes.focus();};
  footer.prepend(remove,save);
}
function openBaekdusan(){
  const {dialog,body,footer}=baekOpen('백두산 만들기');
  body.append(baekElement('p','시작 후원을 고르면 다음 숫자의 후원이 들어올 때마다 한 칸씩 쌓입니다. 후원자는 달라도 괜찮아요.','baek-intro'));
  const runs=state.wallpaper?.baekdusan?.runs||[];
  if(runs.length){const existing=baekElement('div',undefined,'baek-runs');for(const run of runs){const manage=baekElement('button',run.start+'–'+run.target+' · '+run.members.length+'칸 채움 · 관리');manage.onclick=()=>editBaekdusan(run);existing.append(manage);}body.append(existing);}
  const settings=baekSection(body,'01','방송과 범위 설정'),label=baekElement('label',undefined,'baek-field'),select=baekElement('select');
  label.append(baekElement('span','방송 선택'),select);settings.append(label);
  for(const session of state.wallpaper?.sessions||[]){const option=baekElement('option',new Date(session.startedAt||session.started_at).toLocaleString('ko-KR')+' · '+(session.label||'방송'));option.value=session.id;select.append(option);}select.value=(state.wallpaper?.selectedSessionIds||[])[0]||select.value;
  const fields=baekElement('div',undefined,'baek-fields');settings.append(fields);
  const startAmount=baekField(fields,'시작 별풍선 수량',1),target=baekField(fields,'목표 별풍선 수량',100);startAmount.min='1';target.min='1';
  settings.append(baekElement('p','예: 1 → 100이면 100칸을 미리 준비합니다. 한 묶음은 최대 500칸입니다.','baek-help'));
  const picker=baekSection(body,'02','시작 후원 선택'),searchHead=baekElement('div',undefined,'baek-search-head'),load=baekElement('button','후원 찾기'),list=baekElement('div',undefined,'baek-list'),more=baekElement('button','다음 후원 더 보기','baek-more');
  searchHead.append(picker.firstChild,load);picker.append(searchHead,list,more);more.hidden=true;
  const details=baekElement('details',undefined,'baek-details');details.append(baekElement('summary','저장·표시 안내'),baekElement('p','이 PC에 계정별로 저장되며, 보관 중인 최근 7일 방송에서 시작할 수 있습니다. 방송당 하나씩 만들 수 있습니다.'),baekElement('p','백두산은 화면 표시 회차로 선택한 방송에서만 보입니다. 다른 방송을 고르면 회차 선택도 확인해주세요.'));body.append(details);
  const summary=baekElement('div',undefined,'baek-summary'),create=baekElement('button','백두산 만들기','baek-primary');create.disabled=true;footer.prepend(summary,create);
  let cursor=0,chosen=null,generation=0,loading=false;
  function updateSummary(){summary.replaceChildren();if(!chosen){summary.append(baekElement('span','시작할 후원을 먼저 선택해주세요.'));return;}const end=Number(target.value),valid=Number.isSafeInteger(end)&&end>=chosen.amount&&end-chosen.amount<500;summary.append(baekElement('strong',valid?chosen.amount+' → '+end+' · '+(end-chosen.amount+1)+'칸 준비':'목표 수량을 확인해주세요.'),baekElement('span',chosen.actorName+' · '+new Date(chosen.receivedAt).toLocaleString('ko-KR')));}
  const empty=text=>{list.replaceChildren(baekElement('div',text,'baek-empty'));};
  const reset=()=>{generation++;cursor=0;chosen=null;create.disabled=true;more.hidden=true;empty('수량을 입력하고 ‘후원 찾기’를 눌러주세요.');baekMessage('');updateSummary();};
  select.onchange=reset;startAmount.oninput=reset;target.oninput=updateSummary;reset();
  async function fetchPage(first){
    if(loading)return;if(first)reset();const ticket=generation;loading=true;load.disabled=true;more.disabled=true;load.textContent='찾는 중…';
    try{baekMessage('후원 기록을 불러오는 중입니다…');const amount=Number(startAmount.value);if(!Number.isSafeInteger(amount)||amount<1)throw new Error('시작 수량을 입력해주세요.');
      const response=await baekControl({action:'baekdusan-log',sessionId:select.value,amount,afterSequence:cursor});if(ticket!==generation||!dialog.isConnected)return;
      if(first)list.replaceChildren();
      for(const tip of response.tiles){
        const button=baekElement('button',undefined,'baek-tip'),copy=baekElement('span',undefined,'baek-tip-copy'),time=baekElement('time',new Date(tip.receivedAt).toLocaleString('ko-KR'));time.dateTime=tip.receivedAt;copy.append(baekElement('strong',tip.actorName),time);
        const mark=baekElement('span','✓','baek-tip-mark');mark.setAttribute('aria-hidden','true');button.append(mark,copy,baekElement('span',tip.amount+'개','baek-amount'));button.setAttribute('aria-pressed','false');
        button.onclick=()=>{chosen=tip;for(const row of list.children)row.setAttribute('aria-pressed',String(row===button));create.disabled=false;baekMessage('');updateSummary();};list.append(button);
      }
      cursor=response.nextSequence;more.hidden=!response.hasMore;
      if(!list.children.length){empty('해당 수량의 후원이 없습니다. 방송이나 시작 수량을 바꿔보세요.');baekMessage('해당 수량의 후원 기록이 없습니다.');}else baekMessage('백두산이 시작된 후원을 선택해주세요.');
    }catch(error){if(ticket===generation)baekMessage(error.message);}finally{loading=false;load.disabled=false;more.disabled=false;load.textContent='후원 찾기';}
  }
  load.onclick=()=>fetchPage(true);more.onclick=()=>fetchPage(false);
  create.onclick=()=>{if(!chosen)return;const number=Number(target.value);if(!Number.isSafeInteger(number)||number<chosen.amount||number-chosen.amount>=500){baekMessage('목표는 시작 숫자 이상, 최대 500칸까지 입력해주세요.');return;}void baekMutate({action:'baekdusan-create',sessionId:chosen.sessionId,tileId:chosen.id,target:number});};
  if(state.wallpaper?.baekdusan?.error)baekMessage(state.wallpaper.baekdusan.error);
}
document.getElementById('openBaekdusanBtn').onclick=openBaekdusan;
