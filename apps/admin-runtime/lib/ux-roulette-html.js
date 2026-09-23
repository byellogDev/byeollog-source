import {reviewHeader} from './dashboard-review-shell.js';
export function uxRouletteHtml(){return `${reviewHeader("pending","history","룰렛 연결 대기 확인","후원에 연결될 룰렛 결과가 남아 있는지 확인하세요.",'<button id="uxRefreshStatus" type="button">새로고침</button>')}<article class="reviewBody card uxStatusCard"><p class="reviewNotice muted"><b>수동 룰렛은 후원들의 결과 처리가 모두 끝나고, 연결 대기 후원이 없는 상황에서 사용해주세요.</b><br>수동 결과와 후원 결과의 채팅 문구가 같아 자동으로 구분할 수 없습니다. 대기 후원이 있으면 수동 결과가 그 후원에 연결될 수 있습니다. 0건 확인 후에도 새 후원이 들어올 수 있으니 실행 전후로 확인해주세요.</p><p id="uxStatusMessage" role="status" class="muted">확인 전입니다.</p><details><summary>대기 후원 상세 · 오래된 대기 정리</summary><p class="muted">대기 시간이 10분을 넘긴 후원은 이후 결과 연결을 막을 수 있습니다. 결과 처리가 끝났거나 더 이상 오지 않는 것을 확인한 후에만 대기를 종료해주세요. 후원 금액과 이미 등록된 업보는 유지됩니다.</p><div id="uxPendingList" class="saved"></div></details><details><summary>특수룰렛 배수 대기 · 최근 결과</summary><div id="uxSpecialPending" class="saved"></div><div id="uxSpecialRecent" class="saved"></div><p class="muted">배수 대기는 방송 단위이며, 다음 결과가 비업보이면 효과가 소멸합니다. 아래 배수는 결과 수신 시 확정된 값이며 실제 업보 등록 여부는 후원 내역에서 확인해주세요.</p></details></article>`}
export function uxRouletteScript(){return String.raw`
let uxStatus=null,uxStatusLoading=false;
const uxDate=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'기록 없음';
function uxText(tag,text){const el=document.createElement(tag);el.textContent=text;return el}
function uxMappingCounts(){for(const row of $('rouletteSaved')?.querySelectorAll('.mappingRule')||[]){const amount=Number(row.querySelector('b')?.textContent.replace(/[^0-9]/g,''));let label=row.querySelector('.uxPendingCount');if(!label){label=uxText('span','');label.className='chips uxPendingCount';row.append(label)}label.textContent=uxStatus?'연결 대기 '+Number(uxStatus.byAmount?.find(x=>Number(x.amount)===amount)?.count||0)+'건':'연결 대기 확인 전'}}
async function uxRefreshStatus(){
  if(uxStatusLoading)return;uxStatusLoading=true;$('uxRefreshStatus').disabled=true;$('uxStatusMessage').textContent='현재 대기를 확인하는 중입니다.';
  try{
    const response=await fetch('/api/admin?operation=ux-controls&kind=status',{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.message||'대기를 확인하지 못했습니다.');uxStatus=data;
    setDashboardCount?.('roulettePendingBadge',data.pendingCount,'연결 대기');
    $('uxStatusMessage').textContent='연결 대기 '+data.pendingCount+'건 · '+uxDate(data.checkedAt)+' (한국 시간) 확인. '+(data.pendingCount?'수동 룰렛 사용을 미뤄주세요.':'새 후원이 들어오면 대기가 다시 생길 수 있습니다.');
    const host=$('uxPendingList');host.replaceChildren();if(!data.pending?.length)host.append(uxText('p','현재 표시할 대기 후원이 없습니다.'));
    for(const item of data.pending||[]){const row=uxText('div','');row.className='exceptionRow';row.append(uxText('b',(item.actor_name||'이름 없음')+' · '+Number(item.amount).toLocaleString()+'개 · '+(item.roulette_name||'룰렛')));row.append(uxText('p',uxDate(item.occurred_at)+' · '+item.result_count+'/'+item.expected_spins+'회 결과 수집'));
      if(Date.parse(data.checkedAt)-Date.parse(item.occurred_at)>600000){const close=uxText('button','이 후원의 대기 종료');close.type='button';close.onclick=async()=>{if(!confirm('이 후원에 더 이상 결과를 연결하지 않고 대기를 종료할까요? 후원 금액과 기존 업보는 유지되며, 이후 도착하는 결과는 다른 대기 후원에 연결되거나 예외로 남을 수 있습니다.'))return;close.disabled=true;try{const r=await fetch('/api/admin?operation=ux-controls&kind=close-pending',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,updatedAt:item.updated_at})});const d=await r.json();if(!r.ok)throw Error(d.message||'대기 종료 실패');await uxRefreshStatus()}catch(error){$('uxStatusMessage').textContent=error.message;close.disabled=false}};row.append(close)}host.append(row)}
    if(data.pendingCount>50)host.append(uxText('p','가장 오래된 50건을 표시했습니다.'));
    const pending=$('uxSpecialPending');pending.replaceChildren(uxText('h3','현재 방송의 배수 대기'));
    if(!data.specialPending?.length)pending.append(uxText('p','적용을 기다리는 배수가 없습니다.'));
    for(const s of data.specialPending||[])pending.append(uxText('p',s.fan+' · '+s.multiplier+'배 · '+uxDate(s.expires_at)+' 만료'));
    const recent=$('uxSpecialRecent');recent.replaceChildren(uxText('h3','최근 결과 최대 50건'));
    for(const s of data.specialRecent||[]){const receipt=s.special_roulette||{};recent.append(uxText('p',uxDate(s.occurred_at)+' · '+(s.actor_name||'후원자 기록 없음')+' · '+s.result_text+' · '+(receipt.controlEvent?'다음 '+receipt.pendingMultiplier+'배 대기':'이번 결과 '+(receipt.appliedMultiplier||1)+'배')))}
  }catch(error){uxStatus=null;$('uxPendingList').replaceChildren();$('uxSpecialPending').replaceChildren();$('uxSpecialRecent').replaceChildren();$('uxStatusMessage').textContent=error.message+' 현재 대기가 없는 것으로 판단하지 마세요.'}
  finally{uxStatusLoading=false;$('uxRefreshStatus').disabled=false;uxMappingCounts()}
}
$('uxRefreshStatus').onclick=uxRefreshStatus;
if($('rouletteSaved'))new MutationObserver(()=>{if(!$('rouletteSaved').querySelector('.mappingRule:not(:has(.uxPendingCount))'))return;uxMappingCounts()}).observe($('rouletteSaved'),{childList:true});

`}

