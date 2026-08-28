function esc(value){
  return String(value??'').replace(/[&<>"']/g,character=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[character]);
}
function number(value){return new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format(value)}
function passBadge(value,label=value?'통과':'실패'){
  return `<span class="badge ${value?'pass':'fail'}"><i></i>${esc(label)}</span>`;
}
function metricCard(label,value,detail,tone='navy'){
  return `<article class="metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}
function gateRows(checks){
  const labels={
    exactProbabilityAndDelivery:'확률·중복·재시작 원장',
    soopDonationChatCorrelation:'후원·첫 채팅 결합',
    threeSecondPipelineBudget:'3초 룰렛 시간 예산',
    ttsArchitectureCapacityModel:'TTS 분리 구조 용량 모델',
    faultRecoveryMatrix:'장애 복구 행렬'
  };
  return Object.entries(checks).map(([key,value])=>`<tr><td>${esc(labels[key]||key)}</td><td>${passBadge(value)}</td></tr>`).join('');
}
function probabilityRows(report){
  return report.reliability.probability.items.map(item=>`<tr>
    <td>${esc(item.resultText)}</td><td>${number(item.probabilityPpm/10_000)}%</td>
    <td>${number(item.observed)}</td><td>${number(item.expected)}</td>
    <td class="${Math.abs(item.zScore)<6?'ok':'bad'}">${number(item.zScore)}σ</td>
  </tr>`).join('');
}
function latencyRows(metrics){
  const labels={
    donationToOverlayMs:'후원 → 오버레이 시작',
    resultRevealToCachedTtsMs:'결과 공개 → 캐시 TTS',
    chatArrivalToFirstAudioMs:'채팅 → 첫 음성',
    donationToResultAudioMs:'후원 → 결과 음성 전체'
  };
  const budgets={donationToOverlayMs:250,resultRevealToCachedTtsMs:100,chatArrivalToFirstAudioMs:1_000,donationToResultAudioMs:3_350};
  return Object.entries(metrics).map(([key,value])=>{
    const budget=budgets[key];const ratio=Math.min(100,Math.round(value.p95/budget*100));
    return `<tr><td>${esc(labels[key]||key)}</td><td>${number(value.p50)}ms</td><td><b>${number(value.p95)}ms</b></td>
      <td>${number(value.p99)}ms</td><td><div class="budget"><span style="width:${ratio}%"></span></div><small>${number(budget)}ms 기준</small></td></tr>`;
  }).join('');
}
function ttsRows(providers){
  return providers.map(provider=>`<tr><td><b>${esc(provider.label)}</b><small>${esc(provider.key)}</small></td>
    <td>${number(provider.latencyMs.p50)}ms</td><td>${number(provider.latencyMs.p95)}ms</td>
    <td>${number(provider.errorRatePercent)}%</td><td>${number(provider.qualityAssumption)}/5*</td></tr>`).join('');
}
function faultRows(scenarios){
  const labels={
    network_partition:'네트워크 단절',agent_disconnect:'Agent 종료',obs_restart:'OBS 재시작',
    server_crash_after_commit:'커밋 직후 서버 종료',overlay_reload:'오버레이 새로고침',tts_unavailable:'TTS 중단'
  };
  return scenarios.map(item=>`<tr><td>${esc(labels[item.name]||item.name)}</td><td>${passBadge(item.passed)}</td>
    <td>${number(item.recoveryMs)}ms</td><td>${item.visibleExecutions}</td><td>${item.duplicateSuppressed}</td>
    <td>${item.fallbackUsed?'텍스트/내장 음성':'불필요'}</td></tr>`).join('');
}

export function renderNativeRouletteReadinessDashboard(report){
  if(!report||report.schemaVersion!==1)throw new Error('Unsupported readiness report');
  const statusPass=report.status==='CONDITIONAL_PASS';
  const correlation=report.correlation.summary.stats;
  const delivery=report.reliability.restart.summary;
  const blockers=report.releaseBlockers.map(item=>`<li>${esc(item)}</li>`).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>별록 Native Roulette Readiness Lab</title>
<style>
:root{--navy:#071a35;--navy2:#102b50;--ink:#13233b;--muted:#6e7e95;--line:#dce5ef;--paper:#fff;--bg:#f3f6fa;--yellow:#ffc54d;--green:#11a979;--greenBg:#e5f8f1;--red:#d64e5a;--redBg:#ffedf0;--blue:#3779d6}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,Pretendard,"Noto Sans KR",system-ui,sans-serif}.wrap{width:min(1440px,calc(100% - 40px));margin:28px auto 70px}.hero{position:relative;overflow:hidden;background:linear-gradient(125deg,var(--navy),#173e6c);color:#fff;border-radius:28px;padding:34px 38px;box-shadow:0 24px 70px #0d28442b}.hero:after{content:"";position:absolute;width:380px;height:380px;border-radius:50%;right:-130px;top:-220px;background:#ffc54d2f}.brand{font-weight:950;letter-spacing:.12em;color:var(--yellow);font-size:13px}.hero h1{font-size:clamp(28px,4vw,50px);margin:12px 0 10px;letter-spacing:-.05em}.hero p{margin:0;color:#c9d7e8}.heroStatus{display:flex;gap:10px;align-items:center;margin-top:24px}.score{font-size:44px;font-weight:950;color:var(--yellow)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0}.metric,.panel{background:var(--paper);border:1px solid var(--line);box-shadow:0 10px 30px #1836530c}.metric{padding:20px;border-radius:18px}.metric span,.metric small{display:block;color:var(--muted)}.metric strong{display:block;font-size:28px;margin:8px 0 3px}.metric.gold{border-top:4px solid var(--yellow)}.metric.green{border-top:4px solid var(--green)}.metric.blue{border-top:4px solid var(--blue)}.panel{border-radius:22px;padding:24px;margin-top:16px}.panel h2{margin:0;font-size:22px}.panel .desc{color:var(--muted);margin:7px 0 20px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding:10px 12px}td{border-bottom:1px solid #edf1f5;padding:12px}tr:last-child td{border-bottom:0}.badge{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;font-weight:850;font-size:12px}.badge i{width:8px;height:8px;border-radius:50%;background:currentColor}.badge.pass{background:var(--greenBg);color:var(--green)}.badge.fail{background:var(--redBg);color:var(--red)}.ok{color:var(--green);font-weight:850}.bad{color:var(--red);font-weight:850}td small{display:block;color:var(--muted);margin-top:4px}.budget{width:120px;height:7px;background:#e8edf3;border-radius:10px;overflow:hidden}.budget span{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--yellow));border-radius:inherit}.notice{border-radius:16px;padding:15px 17px;background:#fff7df;border:1px solid #f5d885;color:#745417;margin-top:14px}.blockers{margin:10px 0 0;padding-left:20px}.blockers li{margin:9px 0}.footer{margin-top:18px;text-align:center;color:var(--muted);font-size:12px}@media(max-width:950px){.grid{grid-template-columns:1fr 1fr}.cols{grid-template-columns:1fr}.panel{overflow:auto}}@media(max-width:560px){.wrap{width:min(100% - 20px,1440px);margin-top:10px}.hero{padding:24px}.grid{grid-template-columns:1fr}.metric{padding:16px}}
</style></head><body><main class="wrap">
<section class="hero"><div class="brand">★ BYEOLLOG QUALITY LAB</div><h1>Native Roulette Readiness</h1>
<p>운영·DB·네트워크와 분리된 자체 룰렛 출시 전 종합검증 보고서</p>
<div class="heroStatus">${passBadge(statusPass,statusPass?'조건부 통과':'실패')}<span class="score">${number(report.readinessScore)}</span><span>/ 100 · 실제 SDK/TTS/E2E 전 최대 90점</span></div></section>
<section class="grid">
${metricCard('확률 시뮬레이션',number(report.reliability.probabilitySpins),'최대 '+number(report.reliability.probability.maxAbsoluteZ)+'σ','gold')}
${metricCard('가상 SOOP 사례',number(report.correlation.caseCount),'후원·채팅·중복·역순','blue')}
${metricCard('정확히 1회 전달',number(delivery.deliveryLedger),`중복 억제 ${number(delivery.metrics.duplicateDeliveriesSuppressed)}건`,'green')}
${metricCard('전체 실행 시간',number(report.elapsedMs)+'ms',esc(report.mode),'navy')}
</section>
<section class="cols"><article class="panel"><h2>출시 게이트</h2><p class="desc">내부 계약은 통과해도 외부 SDK·실측 TTS·실제 OBS 검증 전에는 활성화하지 않습니다.</p><table><tbody>${gateRows(report.checks)}</tbody></table></article>
<article class="panel"><h2>SOOP 후원·채팅 결합</h2><p class="desc">후원 메시지와 메시지 없는 후원의 첫 채팅을 서로 다른 규칙으로 처리합니다.</p>
<div class="grid" style="grid-template-columns:1fr 1fr;margin:0">${metricCard('후원 메시지',number(correlation.donationMessages),'결과 뒤 1회 재생','green')}${metricCard('첫 채팅 포착',number(correlation.followupsCaptured),`역순 복구 ${number(correlation.reorderedRecovered)}건`,'blue')}${metricCard('시간 초과',number(correlation.outsideWindow),'읽지 않고 폐기','gold')}${metricCard('중복 이벤트',number(correlation.duplicates),'재실행 없음','navy')}</div></article></section>
<section class="panel"><h2>3초 룰렛 시간 예산</h2><p class="desc">P95가 방송 체감 목표를 넘는지 판정합니다.</p><table><thead><tr><th>구간</th><th>P50</th><th>P95</th><th>P99</th><th>예산</th></tr></thead><tbody>${latencyRows(report.pipeline.metrics)}</tbody></table></section>
<section class="cols"><article class="panel"><h2>확률 분포</h2><p class="desc">PPM 정수 확률과 rejection sampling 결과의 통계 편차입니다.</p><table><thead><tr><th>상품</th><th>설정</th><th>관측</th><th>기대</th><th>편차</th></tr></thead><tbody>${probabilityRows(report)}</tbody></table></article>
<article class="panel"><h2>장애 주입 결과</h2><p class="desc">장애 복구 뒤 유실 0건·사용자 노출 1회를 강제합니다.</p><table><thead><tr><th>장애</th><th>판정</th><th>복구</th><th>실행</th><th>중복 억제</th><th>대체</th></tr></thead><tbody>${faultRows(report.faults.scenarios)}</tbody></table></article></section>
<section class="panel"><h2>TTS 용량 모델</h2><p class="desc">룰렛 결과는 사전 캐시, 동적 채팅은 초저지연 스트리밍 후보로 분리하는 구조입니다.</p>
<div class="notice"><b>주의:</b> 아래 값은 구조 용량을 검증하는 합성 모델입니다. 공급자 실제 성능이나 청취 품질로 간주하면 안 됩니다.</div>
<table><thead><tr><th>경로</th><th>P50</th><th>P95</th><th>오류율</th><th>품질 가정</th></tr></thead><tbody>${ttsRows(report.tts.providers)}</tbody></table></section>
<section class="panel"><h2>남은 출시 차단 조건</h2><ul class="blockers">${blockers}</ul></section>
<p class="footer">생성 ${esc(report.generatedAt)} · seed ${esc(report.seed)} · ${esc(report.operatingSystemImpact)}</p>
</main></body></html>`;
}
