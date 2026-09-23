import {dashboardIcon} from './dashboard-icons.js';
export function reviewHeader(kind,icon,title,description,actions){
 return `<header class="reviewHeader"><div class="reviewHeading"><span class="reviewIcon" aria-hidden="true">${dashboardIcon(icon)}</span><div><h2 id="${kind}ReviewTitle">${title}</h2><p>${description}</p></div></div><div class="reviewHeaderActions">${actions}<button type="button" data-review-close="${kind}" aria-label="${title} 닫기">닫기</button></div></header>`;
}
export function dashboardLearningHtml(){return `<section class="reviewPanel hidden" id="collectorBox" aria-labelledby="learningReviewTitle">
${reviewHeader("learning","rules","학습 필요한 별풍선","처음 들어온 룰렛 결과를 분류하면, 같은 결과는 다음부터 자동으로 처리됩니다.",'<button type="button" onclick="loadCollectorInbox(true)">새로고침</button>')}
<div class="reviewBody"><div class="reviewMeta"><div id="collectorState" class="muted" role="status"></div><div class="reviewAuxActions"><button type="button" onclick="openCollectorRuleManager()">학습된 분류 관리</button></div></div>
    <div id="collectorSummary" class="collectorSummary"></div>
    <div id="collectorUnknownRules"></div>
    <div id="collectorPendingActions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
      <button class="primary" id="collectorProcessBtn" onclick="processCollectorInbox()">분류 완료 데이터 전체 등록</button>
      <span class="muted">처음 보는 유형만 수동 분류하며, 학습된 유형은 자동 처리됩니다.</span>
    </div>
    <div id="collectorPreview" class="previewTableWrap" style="margin-top:10px"><div class="muted" style="padding:10px">수신함을 불러오세요.</div></div>
  </div></section>`}
