export function reverseFanDayDraftScript(){return String.raw`
// Only form data, isolated by user + workspace and retained for this tab, up to 24h.
let rfDraftKey=null,rfDraftBaseline='',rfDraftOffer=null,rfUndoRule=null;
const rfDraftFields=['rfName','rfStart','rfEnd'];
function rfDraftValue(){return {fields:Object.fromEntries(rfDraftFields.map(id=>[id,$(id).value])),rules:[...$('rfRules').children].map(row=>[...row.querySelectorAll('input')].map(input=>input.value)),editing:rf.editing?{id:rf.editing.id,revision:rf.editing.revision}:null,createId:rf.createId}}
function rfDraftDirty(){return rfDraftBaseline&&JSON.stringify(rfDraftValue())!==rfDraftBaseline}
function rfDraftClear(){try{if(rfDraftKey)sessionStorage.removeItem(rfDraftKey)}catch{}rfDraftOffer=null;$('rfDraftNotice').replaceChildren();rfUndoRule=null;rfDraftBaseline=JSON.stringify(rfDraftValue())}
function rfDraftSave(){if(!rfDraftKey||!rfDraftDirty())return;try{sessionStorage.setItem(rfDraftKey,JSON.stringify({at:Date.now(),value:rfDraftValue()}))}catch{$('rfDraftNotice').textContent='이 브라우저에서는 임시 저장이 안 됩니다. 입력 창을 닫기 전에 회차를 저장해주세요.'}}
function rfInitDraft(context){
 if(!context?.user_id||!context?.workspace_slug)return;
 const key='byeollog-rf-draft-v1:'+context.user_id+':'+context.workspace_slug;if(rfDraftKey===key)return;
 if(rfDraftKey)rfReset();rfDraftKey=key;
 try{const raw=sessionStorage.getItem(key);if(!raw)return;if(raw.length>24000)throw Error();const data=JSON.parse(raw),v=data.value;
 if(!Number.isFinite(data.at)||Date.now()-data.at>86400000||data.at>Date.now()+30000||!v||!v.fields||!Array.isArray(v.rules)||v.rules.length<1||v.rules.length>30||!v.rules.every(row=>Array.isArray(row)&&row.length===3&&row.every(x=>typeof x==='string'&&x.length<40))||!rfDraftFields.every(id=>typeof v.fields[id]==='string'&&v.fields[id].length<200)||!/^[a-f0-9-]{36}$/i.test(v.createId||'')||v.editing&&(!/^[a-f0-9-]{36}$/i.test(v.editing.id||'')||!Number.isInteger(v.editing.revision)))throw Error();
 rfDraftOffer=v;const restore=rfEl('button','작성하던 내용 불러오기'),discard=rfEl('button','임시 내용 삭제');restore.type=discard.type='button';
 restore.onclick=()=>{if(rf.busy||!rfDraftOffer)return;if(rfDraftDirty()&&!confirm('현재 입력을 임시 저장된 내용으로 바꿀까요?'))return;const v=rfDraftOffer;rf.editing=v.editing;rf.createId=v.createId;for(const id of rfDraftFields)$(id).value=v.fields[id];$('rfRules').replaceChildren();for(const rule of v.rules){rfAddRule();const row=$('rfRules').lastElementChild;[...row.querySelectorAll('input')].forEach((input,i)=>input.value=rule[i])}$('rfFormTitle').textContent=v.editing?'회차 조건 수정 · 임시 내용':'새 역팬데이 · 임시 내용';$('rfSave').textContent=v.editing?'수정 저장':'회차 저장';$('rfCancelEdit').classList.toggle('hidden',!v.editing);rfDraftOffer=null;$('rfDraftNotice').textContent='입력을 불러왔습니다. 기간과 금액을 확인한 뒤 저장해주세요. 저장 전에는 회차에 반영되지 않습니다.';rfDraftSave();$('rfName').focus()};
 discard.onclick=()=>{rfDraftClear();rfDraftSave()};$('rfDraftNotice').replaceChildren(rfEl('p','이 탭에서 작성하다 남겨둔 입력이 있습니다. 서버에 저장된 회차와는 별개입니다.'),restore,discard);
 }catch{try{sessionStorage.removeItem(key)}catch{}}
}
function rfRemoveRule(row){if(rf.busy||$('rfRules').children.length<=1)return;rfUndoRule={row,index:[...$('rfRules').children].indexOf(row)};row.remove();const undo=rfEl('button','방금 삭제한 범위 되돌리기');undo.type='button';undo.onclick=()=>{if(rf.busy||!rfUndoRule||$('rfRules').children.length>=30)return;$('rfRules').insertBefore(rfUndoRule.row,$('rfRules').children[rfUndoRule.index]||null);rfUndoRule=null;$('rfDraftNotice').replaceChildren();rfDraftSave()};$('rfDraftNotice').replaceChildren(undo);rfDraftSave()}
$('rfForm').addEventListener('input',rfDraftSave);$('rfForm').addEventListener('change',rfDraftSave);
window.addEventListener('pagehide',rfDraftSave);
window.addEventListener('beforeunload',event=>{if(rfDraftDirty()){rfDraftSave();event.preventDefault();event.returnValue=''}});
`}
