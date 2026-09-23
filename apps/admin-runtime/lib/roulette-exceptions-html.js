export function rouletteExceptionsHtml(){return `<section id="exceptionsPanel" role="tabpanel" aria-labelledby="exceptionsTab" class="hidden"><article class="card">
<h2>예외 처리된 룰렛</h2><p class="muted">후원에 연결되지 않은 결과입니다. 수동·시험 실행인지 확인한 뒤 처리해주세요. 기존 학습 분류가 비업보인 결과는 자동 제외됩니다.<br>다른 후원에 자동 배정되지 않습니다. </p><p class="muted"><strong>정상 등록된 업보·확정 후원 내역은 30일 정리 대상이 아닙니다.</strong> 여기서 후원자를 지정해 등록한 업보도 유지됩니다.<br>30일 정리 대상은 후원·룰렛 연결용 원본 기록과 예외 처리 기록입니다. 보류 중인 예외 결과도 서버 수집일로부터 30일이 지나면 정리되므로, 필요한 예외 기록은 미리 내보내세요.</p>
<div class="exceptionToolbar"><label for="exceptionFilter">표시</label><select id="exceptionFilter"><option value="pending">보류 중</option><option value="processed">처리 완료</option><option value="all">전체</option></select><button id="refreshExceptions" type="button">새로고침</button></div>
<div class="exceptionToolbar"><label>발생 시작일 <input id="exceptionFrom" type="date"></label><label>종료일 <input id="exceptionUntil" type="date"></label><label>사유 <select id="exceptionReason"><option value="">전체 사유</option><option value="fifo_head_stale">대기 시간 초과</option><option value="fifo_head_roulette_mismatch">룰렛 이름 불일치</option><option value="unmatched">대기 후원 없음</option></select></label><label>결과 검색 <input id="exceptionSearchText" maxlength="100" type="search"></label></div>
<div class="exceptionToolbar"><button id="selectExceptions" type="button">현재 목록 최대 50건 선택</button><button id="bulkExcludeExceptions" type="button">선택한 결과 제외</button><button id="exportExceptions" type="button">불러온 목록 CSV 저장</button></div>
<div id="exceptionStatus" class="status" aria-live="polite"></div><div id="exceptionList" class="saved"></div><button id="moreExceptions" class="hidden" type="button">더 보기</button>
</article><dialog id="exceptionDialog" class="exceptionDialog" aria-labelledby="exceptionDialogTitle"><form id="exceptionForm">
<div class="accountDialogHead"><h2 id="exceptionDialogTitle">후원자를 지정해 업보 등록</h2><button id="closeException" type="button" aria-label="등록 창 닫기">닫기</button></div>
<p id="exceptionResultSummary" class="muted"></p><p class="muted">후원 금액은 추가하지 않으며, 입력한 업보와 수량만 등록합니다. 특수룰렛 배수는 적용하지 않습니다.</p>
<div class="field"><label for="exceptionFanSearch">후원자 검색 · 닉네임 또는 SOOP 아이디</label><div class="exceptionSearch"><input id="exceptionFanSearch" maxlength="80" autocomplete="off"><button id="searchExceptionFans" type="button">검색</button></div></div>
<div id="exceptionFans" class="exceptionFans"></div><p id="exceptionFanSelected" class="chips">후원자를 선택해주세요.</p>
<details><summary>검색되지 않는 후원자 새로 지정</summary><p class="muted">SOOP 아이디를 정확히 확인해주세요. 업보 등록과 함께 후원자 목록에 추가됩니다.</p><label>SOOP 아이디 <input id="exceptionNewId" maxlength="80" autocomplete="off"></label><label>표시 이름 <input id="exceptionNewName" maxlength="120"></label><button id="chooseNewExceptionFan" type="button">이 후원자로 지정</button></details>
<div class="exceptionFields"><div class="field"><label for="exceptionEvent">이벤트</label><input id="exceptionEvent" maxlength="120" required></div><div class="field"><label for="exceptionType">업보 종류</label><input id="exceptionType" maxlength="120" required></div><div class="field"><label for="exceptionQuantity">수량</label><input id="exceptionQuantity" type="number" min="1" max="1000" step="1" value="1" required></div></div>
<p id="exceptionConfirm" class="exceptionConfirm" aria-live="polite"></p><div id="exceptionDialogStatus" class="status" aria-live="polite"></div><button id="registerException" class="primary" type="submit">업보 등록</button>
</form></dialog></section>`}

export function rouletteExceptionsCss(){return `.exceptionToolbar,.exceptionSearch{display:flex;gap:8px;align-items:center}.exceptionToolbar{flex-wrap:wrap;margin:10px 0}.exceptionToolbar label{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.exceptionToolbar input{max-width:210px}.classificationPage .exceptionSelect{width:18px;height:18px;margin-right:8px}.exceptionExpiry{font-size:12px;color:var(--muted)}.exceptionExpiry.soon{color:#b45309;font-weight:800}.exceptionToolbar select{font:inherit;padding:9px;border:1px solid var(--line);border-radius:9px;background:var(--soft);color:inherit}.exceptionRow{border:1px solid var(--line);border-radius:13px;padding:14px;background:var(--soft);overflow-wrap:anywhere}.exceptionRow h3{margin:6px 0;font-size:16px}.exceptionRow .ruleActions{margin-top:10px}.exceptionDialog{width:min(600px,calc(100% - 24px));max-height:90dvh;overflow:auto;border:1px solid var(--line);border-radius:18px;padding:20px;color:inherit;background:#fff}.exceptionDialog #closeException{flex-shrink:0;white-space:nowrap}.exceptionDialog::backdrop{background:#0009}.exceptionFields{display:grid;grid-template-columns:1fr 1fr 90px;gap:10px}.exceptionFans{display:grid;gap:5px;max-height:180px;overflow:auto;margin-top:8px}.exceptionFans button{text-align:left}.exceptionFans button[aria-pressed=true]{outline:2px solid var(--green)}.exceptionConfirm{padding:12px;border-radius:10px;background:var(--soft);overflow-wrap:anywhere}.exceptionDialog input:focus-visible,.exceptionDialog button:focus-visible,.exceptionToolbar select:focus-visible{outline:3px solid var(--green);outline-offset:2px}body.classificationPage[data-theme=dark] .exceptionDialog{background:#112746;color:#e9f1fa}@media(max-width:700px){.classificationTabs{flex-wrap:wrap}.classificationTabs button{flex:1 1 40%}.exceptionFields{grid-template-columns:1fr}.exceptionDialog{padding:15px}.exceptionSearch input{min-width:0}.exceptionSearch button{flex-shrink:0}}`}

export function rouletteExceptionsScript({autoLoad=true}={}){return String.raw`
const exState={items:[],cursor:null,filter:'pending',loading:false,busy:false,row:null,fan:null,revision:0,searchRevision:0,returnFocus:null,selected:new Set()};
const exTime=value=>value?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'';
const exLabel=status=>({pending:'보류 중',excluded:'제외 처리',registered:'업보 등록 완료',auto_excluded:'비업보 자동 제외'})[status]||'보류 중';
async function exceptionApi(params={},body){
  const search=new URLSearchParams({operation:'roulette-exceptions',...params});
  const response=await fetch('/api/admin?'+search,{method:body?'POST':'GET',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>({}));
  if(response.status===401){location.replace('/login?expired=1');throw Error('로그인이 필요합니다.')}
  if(!response.ok)throw Error(data.message||'요청을 처리하지 못했습니다.');
  if(body)window.dispatchEvent(new Event('byeollog:exception-resolved'));
  return data;
}
function exElement(tag,text,className){const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element}
function exBusy(busy){exState.busy=busy;for(const button of $('exceptionList').querySelectorAll('button'))button.disabled=busy;for(const input of $('exceptionForm').querySelectorAll('button,input'))input.disabled=busy;$('exceptionDialog').setAttribute('aria-busy',String(busy))}
function renderExceptions(){
  const host=$('exceptionList');host.replaceChildren();
  if(!exState.items.length)renderEmpty(host,exState.filter==='pending'?'확인이 필요한 룰렛 결과가 없습니다.':'처리 내역이 없습니다.');
  for(const item of exState.items){
    const row=exElement('article','','exceptionRow');
    const reason=item.match_method==='fifo_head_stale'?'대기 후원 시간 초과':item.match_method==='fifo_head_roulette_mismatch'?'대기 후원과 룰렛 이름 불일치':item.match_state==='ambiguous'?'연결할 후원을 확정할 수 없음':'연결할 대기 후원 없음';
    row.append(exElement('span',exLabel(item.review_status),item.review_status==='pending'?'badge wait':'badge'),exElement('h3',item.result_text),exElement('p','발생 '+exTime(item.occurred_at)+' (한국 시간) · '+reason,'chips'));
    const expires=item.created_at?new Date(Date.parse(item.created_at)+30*86400000):null;
    if(expires){const days=Math.ceil((expires-Date.now())/86400000);row.append(exElement('p','예외 원본 기록 정리 시점: '+exTime(expires)+' (수집일 + 30일) · '+(days>0?days+'일 남음':'보관기간 경과'),'exceptionExpiry'+(days<=3?' soon':'')))}
    const head=item.review_details?.fifoHead;
    if(head)row.append(exElement('p','당시 대기 후원: '+(head.actor_name||'이름 없음')+' · '+head.amount+'개 · '+exTime(head.occurred_at)+' · '+head.result_count+'/'+head.expected_spins+'회 결과 수집','chips'));
    else if(item.match_method==='fifo_head_stale')row.append(exElement('p','먼저 들어온 후원이 10분 넘게 결과를 기다려 자동 연결하지 않은 상태입니다. 이 기록에는 당시 후원 상세가 없어 현재 대기 목록과 원문을 함께 확인해주세요.','chips'));
    const raw=document.createElement('details');raw.append(exElement('summary','원문 보기'),exElement('p',item.raw_message,'chips'));row.append(raw);
    if(item.review_status==='pending'){
      const label=exElement('label','선택'),check=document.createElement('input');check.type='checkbox';check.className='exceptionSelect';check.checked=exState.selected.has(item.id);check.onchange=()=>{if(check.checked&&exState.selected.size>=50){check.checked=false;setStatus('exceptionStatus','한 번에 최대 50건을 선택할 수 있습니다.','error');return}if(check.checked)exState.selected.add(item.id);else exState.selected.delete(item.id);$('bulkExcludeExceptions').textContent='선택한 '+exState.selected.size+'건 제외'};label.prepend(check);row.prepend(label);
      const actions=exElement('div','','ruleActions'),exclude=exElement('button','제외 처리'),register=exElement('button','후원자를 지정해 업보 등록','primary');
      exclude.type=register.type='button';exclude.onclick=()=>excludeException(item);register.onclick=()=>openException(item,register);actions.append(exclude,register);row.append(actions);
    }else{
      const decision=item.review_details?.decision;
      row.append(exElement('p','처리 '+exTime(item.reviewed_at)+(item.review_status==='registered'?' · '+(item.review_details?.fan||decision?.soopId||'')+' · '+decision?.event+' · '+decision?.type+' × '+decision?.quantity:''),'chips'));
    }
    if(['registered','excluded'].includes(item.review_status)){
      const undo=exElement('button','처리 취소 · 보류로 되돌리기');undo.type='button';undo.onclick=()=>undoException(item);row.append(undo);
    }
    const history=exElement('details'),summary=exElement('summary','처리 이력');history.append(summary);let historyLoaded=false;
    history.ontoggle=async()=>{if(!history.open||historyLoaded)return;historyLoaded=true;const status=exElement('p','불러오는 중…','chips');history.append(status);try{const data=await exceptionApi({historyId:item.id});status.textContent=data.items.length?'최근 '+data.items.length+'건':'저장된 추가 이력이 없습니다.';for(const entry of data.items)history.append(exElement('p',exTime(entry.created_at)+' · '+exLabel(entry.previous_status)+' → '+(entry.action==='undo'?'보류 중':exLabel(entry.action)),'chips'))}catch(error){status.textContent=error.message;historyLoaded=false}};row.append(history);
    host.append(row);
  }
  $('moreExceptions').classList.toggle('hidden',!exState.cursor);exBusy(exState.busy);
}
async function loadExceptions(more=false){
  if(exState.loading||exState.busy)return;exState.loading=true;
  const revision=++exState.revision,filter=$('exceptionFilter').value;
  $('refreshExceptions').disabled=$('moreExceptions').disabled=$('exceptionFilter').disabled=true;
  setStatus('exceptionStatus','불러오는 중입니다.');
  try{
    const data=await exceptionApi({filter,from:$('exceptionFrom').value,until:$('exceptionUntil').value,reason:$('exceptionReason').value,search:$('exceptionSearchText').value.trim(),...(more&&exState.cursor?{before:exState.cursor}:{})});
    if(revision!==exState.revision)return;
    exState.selected.clear();$('bulkExcludeExceptions').textContent='선택한 결과 제외';exState.filter=filter;exState.items=more?[...exState.items,...data.items]:data.items;exState.cursor=data.nextCursor;renderExceptions();
    if(filter==='pending'&&$('exceptionsTab'))$('exceptionsTab').textContent='예외 처리된 룰렛'+(exState.items.length?' ('+exState.items.length+(data.nextCursor?'+':'')+')':'');
    window.dispatchEvent(new Event('byeollog:exceptions-updated'));
    setStatus('exceptionStatus','');
  }catch(error){setStatus('exceptionStatus',error.message,'error')}
  finally{exState.loading=false;$('refreshExceptions').disabled=$('moreExceptions').disabled=$('exceptionFilter').disabled=false}
}
async function excludeException(item){
  if(exState.busy||!confirm(exTime(item.occurred_at)+' · '+item.result_text+' 결과를 제외 처리할까요?'))return;
  exBusy(true);let success=false;
  try{await exceptionApi({},{id:item.id,action:'excluded'});success=true}
  catch(error){setStatus('exceptionStatus',error.message,'error')}
  finally{exBusy(false)}
  if(success){await loadExceptions();setStatus('exceptionStatus','제외 처리했습니다. 처리 완료 목록에서 확인할 수 있습니다.','ok')}
}
function confirmException(){
  $('exceptionConfirm').textContent=(exState.fan?exState.fan.alias||exState.fan.current_nickname||exState.fan.soop_id:'후원자 미선택')+' · '+($('exceptionEvent').value.trim()||'이벤트 미입력')+' · '+($('exceptionType').value.trim()||'업보 미입력')+' × '+$('exceptionQuantity').value;
}
function openException(item,button){
  if(exState.busy)return;exState.row=item;exState.fan=null;exState.returnFocus=button;exState.searchRevision++;
  $('exceptionForm').reset();$('exceptionFans').replaceChildren();$('exceptionFanSelected').textContent='후원자를 선택해주세요.';
  $('exceptionResultSummary').textContent=exTime(item.occurred_at)+' (한국 시간) · '+item.result_text;
  $('exceptionEvent').value=item.roulette_name||'';$('exceptionType').value=item.result_text;$('exceptionFanSearch').value=item.donor_name_hint||'';
  setStatus('exceptionDialogStatus','');confirmException();$('exceptionDialog').showModal();$('exceptionFanSearch').focus();
}
function closeException(){if(exState.busy)return;exState.searchRevision++;$('exceptionDialog').close();exState.returnFocus?.focus()}
async function searchExceptionFans(){
  const revision=++exState.searchRevision,term=$('exceptionFanSearch').value.trim();
  exState.fan=null;confirmException();$('exceptionFanSelected').textContent='후원자를 선택해주세요.';$('exceptionFans').replaceChildren();setStatus('exceptionDialogStatus','검색 중입니다.');
  try{
    const data=await exceptionApi({fans:term});if(revision!==exState.searchRevision)return;
    for(const fan of data.fans){
      const button=exElement('button',(fan.alias||fan.current_nickname||fan.soop_id)+' · '+fan.soop_id);button.type='button';button.setAttribute('aria-pressed','false');
      button.onclick=()=>{exState.fan=fan;for(const other of $('exceptionFans').children)other.setAttribute('aria-pressed',String(other===button));$('exceptionFanSelected').textContent='선택: '+button.textContent;confirmException()};$('exceptionFans').append(button);
    }
    setStatus('exceptionDialogStatus',data.fans.length===20?'최대 20명 표시됩니다. 검색어를 더 구체적으로 입력할 수 있습니다.':data.fans.length?'후원자를 선택해주세요.':'등록된 후원자가 없습니다. 아래에서 SOOP 아이디와 이름을 직접 지정할 수 있습니다.');
  }catch(error){if(revision===exState.searchRevision)setStatus('exceptionDialogStatus',error.message,'error')}
}
async function registerException(event){
  event.preventDefault();if(exState.busy||!exState.row)return;
  if(!exState.fan)return setStatus('exceptionDialogStatus','후원자를 검색하고 선택해주세요.','error');
  const body={id:exState.row.id,action:'registered',soopId:exState.fan.soop_id,...(exState.fan.createFan?{createFan:true,fanName:exState.fan.alias}:{}),event:$('exceptionEvent').value.trim(),type:$('exceptionType').value.trim(),quantity:Number($('exceptionQuantity').value)};
  if(!body.event||!body.type||!Number.isSafeInteger(body.quantity)||body.quantity<1||body.quantity>1000)return setStatus('exceptionDialogStatus','이벤트·업보 종류와 수량(1~1,000)을 확인해주세요.','error');
  exState.searchRevision++;exBusy(true);let result;
  try{result=await exceptionApi({},body)}catch(error){setStatus('exceptionDialogStatus',error.message,'error')}
  finally{exBusy(false)}
  if(result){closeException();await loadExceptions();setStatus('exceptionStatus',result.status==='auto_excluded'?'비업보로 학습된 결과여서 자동 제외했습니다.':'지정한 후원자에게 업보를 등록했습니다.','ok')}
}
$('refreshExceptions').onclick=()=>loadExceptions();$('moreExceptions').onclick=()=>loadExceptions(true);$('exceptionFilter').onchange=()=>loadExceptions();$('closeException').onclick=closeException;
$('exceptionDialog').addEventListener('cancel',event=>{event.preventDefault();closeException()});$('searchExceptionFans').onclick=searchExceptionFans;$('exceptionForm').onsubmit=registerException;
$('exceptionFanSearch').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void searchExceptionFans()}};
for(const id of ['exceptionEvent','exceptionType','exceptionQuantity'])$(id).oninput=confirmException;
async function undoException(item){
  if(exState.busy||!confirm('이 처리를 취소하고 보류로 되돌릴까요?'+(item.review_status==='registered'?' 이 결과로 등록한 수량을 차감합니다. 업보가 변경되거나 일부 완료됐다면 취소할 수 없습니다.':'')+' 후원자를 바꾸려면 취소 후 다시 등록해주세요.'))return;
  exBusy(true);let success=false;try{await exceptionApi({},{id:item.id,action:'undo'});success=true}catch(error){setStatus('exceptionStatus',error.message,'error')}finally{exBusy(false)}if(success){await loadExceptions();setStatus('exceptionStatus','보류로 되돌렸습니다. 필요한 후원자를 다시 지정할 수 있습니다.','ok')}
}
$('chooseNewExceptionFan').onclick=()=>{const id=$('exceptionNewId').value.trim().toLowerCase(),name=$('exceptionNewName').value.trim();if(!/^[a-z0-9_.-]{2,80}$/.test(id)||!name)return setStatus('exceptionDialogStatus','SOOP 아이디와 표시 이름을 확인해주세요.','error');exState.fan={soop_id:id,alias:name,createFan:true};$('exceptionFanSelected').textContent='새 후원자: '+name+' · '+id;confirmException();setStatus('exceptionDialogStatus','업보 등록 시 후원자 목록에 함께 추가됩니다.')};
$('selectExceptions').onclick=()=>{if(exState.busy)return;exState.selected=new Set(exState.items.filter(i=>i.review_status==='pending').slice(0,50).map(i=>i.id));renderExceptions();$('bulkExcludeExceptions').textContent='선택한 '+exState.selected.size+'건 제외'};
$('bulkExcludeExceptions').onclick=async()=>{if(exState.busy||!exState.selected.size)return;if(!confirm('선택한 '+exState.selected.size+'건을 제외 처리할까요? 각 결과별로 처리하며 일부 실패할 수 있습니다.'))return;exBusy(true);let data;try{data=await exceptionApi({},{action:'bulk-excluded',ids:[...exState.selected]})}catch(error){setStatus('exceptionStatus',error.message,'error')}finally{exBusy(false)}if(data){await loadExceptions();const failed=data.results.filter(r=>!r.ok);setStatus('exceptionStatus',(data.results.length-failed.length)+'건 제외 · '+failed.length+'건 실패'+(failed.length?' — '+failed[0].message:''),failed.length?'error':'ok')}};
$('exportExceptions').onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';const rows=[['발생 시각(한국)','결과','상태','사유','수집 시각(한국)','정리 대상 시점(한국)'],...exState.items.map(i=>[exTime(i.occurred_at),i.result_text,exLabel(i.review_status),i.match_method,exTime(i.created_at),i.created_at?exTime(new Date(Date.parse(i.created_at)+30*86400000)):''])];const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='별록-예외-불러온목록.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('exceptionSearchText').onkeydown=event=>{if(event.key==='Enter')void loadExceptions()};
${autoLoad?'queueMicrotask(()=>loadExceptions());':''}
`}
