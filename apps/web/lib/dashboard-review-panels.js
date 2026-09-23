import {reviewHeader} from './dashboard-review-shell.js';
import {rouletteExceptionsHtml,rouletteExceptionsCss,rouletteExceptionsScript} from './roulette-exceptions-html.js';

export function dashboardExceptionsHtml(){
 return rouletteExceptionsHtml()
 .replace('role="tabpanel" aria-labelledby="exceptionsTab" class="hidden"','role="region" aria-labelledby="exceptionsReviewTitle" class="reviewPanel hidden"')
 .replace('<article class="card">',reviewHeader('exceptions','roulette','예외 처리된 룰렛','후원에 연결되지 않은 결과를 확인하고, 제외하거나 후원자를 지정해주세요.','<button id="refreshExceptions" type="button">새로고침</button>')+'<article class="reviewBody card">')
 .replace('<h2>예외 처리된 룰렛</h2>','')
 .replace('<p class="muted">후원에 연결되지 않은 결과입니다. 수동·시험 실행인지 확인한 뒤 처리해주세요. 기존 학습 분류가 비업보인 결과는 자동 제외됩니다.<br>다른 후원에 자동 배정되지 않습니다. </p>','<p class="reviewNotice muted">다른 후원에 자동으로 배정되지 않습니다. 비업보로 분류된 결과는 자동 제외됩니다.</p>')
 .replace('<p class="muted"><strong>정상 등록된 업보','<details class="reviewHelp"><summary>기록 보관 기간 안내</summary><p class="muted"><strong>정상 등록된 업보')
 .replace('필요한 예외 기록은 미리 내보내세요.</p>','필요한 예외 기록은 미리 내보내세요.</p></details>')
 .replace('<button id="refreshExceptions" type="button">새로고침</button></div>','</div>')
 .replace('<div class="exceptionToolbar"><label>발생 시작일','<div class="exceptionToolbar reviewFilterGrid"><label>발생 시작일')
 .replace('<div class="exceptionToolbar"><button id="selectExceptions"','<div class="exceptionToolbar reviewBulkActions"><button id="selectExceptions"');
}
export function dashboardReviewCss(){return rouletteExceptionsCss()+`
.typeQueueCard .typeQueueHead{width:100%;border:0;border-radius:0;text-align:left;color:var(--text);font:inherit;cursor:pointer;min-height:68px}
.typeQueueLabel{display:grid;gap:3px;min-width:0;overflow-wrap:anywhere}
.typeQueueActions{display:flex;align-items:center;gap:12px;flex-shrink:0}
.typeQueueChevron{flex-shrink:0;color:var(--muted);transition:transform .15s ease}
.typeQueueHead[aria-expanded="true"] .typeQueueChevron{transform:rotate(180deg)}
.typeQueueCard .typeQueueHead:hover{background:var(--surface-soft)}
.typeQueueCard .typeQueueHead:focus-visible{outline:3px solid var(--brand-yellow);outline-offset:-4px}
body .toggleBtn[aria-controls][aria-expanded="true"],body[data-theme="dark"] .toggleBtn[aria-controls][aria-expanded="true"]{background:var(--brand-yellow);border-color:var(--brand-yellow);color:#10233f;box-shadow:inset 0 -2px 0 #00000012}
body .toggleBtn[aria-controls][aria-expanded="true"]:hover{background:#ffd36d;border-color:#ffd36d;color:#10233f}
@media(max-width:600px){.typeQueueCard .typeQueueHead{padding:12px;gap:8px}.typeQueueActions{gap:6px}.typeQueueCard .typeCutBadge{min-width:0;padding:7px 8px}.typeQueueCard .typeCutBadge strong{font-size:21px}.typeWorkSummary{flex-wrap:wrap}.typeWorkTotal{white-space:nowrap}}
#exceptionsPanel{--line:var(--border,#dce5ef);--soft:var(--surface-soft,#f7f9fc);--green:#0aa57c;margin:16px 0}
#exceptionsPanel>.card{padding:20px}
#exceptionsPanel .saved{display:grid;gap:10px}
#exceptionsPanel .chips{font-size:12px;line-height:1.6;color:var(--muted)}
#exceptionsPanel .status{min-height:20px;margin:10px 0;font-size:13px}
#exceptionsPanel .status.error{color:#b42318}
#exceptionsPanel .badge{display:inline-flex;padding:5px 9px;border-radius:999px;background:#e7f8f2;color:#087d5f;font-size:12px;font-weight:800}
#exceptionsPanel .badge.wait{background:#fff5d8;color:#8a6111}
#exceptionsPanel .ruleActions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
#exceptionsPanel .ruleActions button{min-height:44px}
#exceptionsPanel .exceptionSelect{width:18px;height:18px;margin-right:8px}
#exceptionsPanel .field{display:grid;gap:6px;min-width:0}
#exceptionsPanel .exceptionDialog{color:var(--text);background:var(--surface,#fff)}
#exceptionsPanel .accountDialogHead{display:flex;justify-content:space-between;gap:12px;align-items:start}
#exceptionsPanel .accountDialogHead h2{margin:0}
#exceptionsPanel input{min-width:0;max-width:100%}
#exceptionsPanel .exceptionDialog input{width:100%}
#exceptionsPanel .exceptionToolbar label{min-width:0}
@media(max-width:700px){#exceptionsPanel>.card{padding:14px}#exceptionsPanel .exceptionToolbar{display:grid;grid-template-columns:minmax(0,1fr)}#exceptionsPanel .exceptionToolbar input,#exceptionsPanel .exceptionToolbar select{width:100%;max-width:none;min-height:44px}#exceptionsPanel .exceptionToolbar label{display:grid;grid-template-columns:minmax(0,1fr)}#exceptionsPanel .ruleActions button{flex:1 1 100%}}
`}
export function dashboardExceptionsScript(){return `(()=>{
const $=id=>document.getElementById(id);
const setStatus=(id,text,kind='')=>{const el=$(id);el.textContent=text;el.className='status '+kind};
const renderEmpty=(host,text)=>{const p=document.createElement('p');p.className='muted reviewEmpty';p.textContent=text;host.append(p)};
${rouletteExceptionsScript({autoLoad:false})}
window.dashboardExceptionPanel={load:loadExceptions,close:()=>{if(exState.busy)return false;if($('exceptionDialog').open)closeException();return true}};
})();`}
