// Embedded into the authenticated dashboard by generate-admin-html.mjs.
let donationReportData=null,donationReportBounds=null,donationReportBusy=false,donationReportRequest=null;
function donationReportControls(busy){
  donationReportBusy=busy;
  for(const id of ['donationReportFrom','donationReportTo'])$(id).disabled=busy||!donationReportBounds?.first;
  $('donationReportBuild').disabled=busy||!donationReportBounds?.first;
  $('donationReportSave').disabled=busy||!donationReportData;
}
function invalidateDonationReport(){
  donationReportData=null;$('donationReportSave').disabled=true;$('donationReportCanvas').classList.add('hidden');$('donationReportSummary').textContent='';
  $('donationReportState').textContent='선택한 기간으로 리포트를 만들어주세요.';
}
function closeDonationReport(){
  donationReportRequest?.abort();$('donationReportPanel').classList.add('hidden');
  $('donationReportOpen').setAttribute('aria-expanded','false');$('donationReportOpen').focus();
}
async function requestDonationReport(params){
  donationReportRequest=new AbortController();
  const response=await fetch('/api/data?'+new URLSearchParams({operation:'donation-report',...params}),{credentials:'same-origin',cache:'no-store',signal:donationReportRequest.signal});
  const data=await response.json();
  if(!response.ok)throw Error(response.status===401?'로그인이 만료되었습니다. 다시 로그인해주세요.':data.message||'리포트를 불러오지 못했습니다.');
  return data;
}
async function openDonationReport(){
  const panel=$('donationReportPanel');panel.classList.remove('hidden');
  $('donationReportOpen').setAttribute('aria-expanded','true');
  panel.focus({preventScroll:true});panel.scrollIntoView({block:'start',behavior:'instant'});
  if(donationReportBusy)return;
  donationReportData=null;donationReportBounds=null;donationReportControls(true);
  $('donationReportCanvas').classList.add('hidden');$('donationReportSummary').textContent='';$('donationReportState').textContent='기록된 첫 방송일과 최근 방송일을 확인하고 있습니다.';
  try{
    const {bounds}=await requestDonationReport({mode:'bounds'});donationReportBounds=bounds;
    for(const id of ['donationReportFrom','donationReportTo']){$(id).min=bounds.first||'';$(id).max=bounds.last||''}
    $('donationReportFrom').value=bounds.first||'';$('donationReportTo').value=bounds.last||'';
    if(!bounds.first){$('donationReportState').textContent='기록된 방송 시작일이 없어 리포트를 만들 수 없습니다. 후원 통계는 기존 탭에서 확인할 수 있습니다.';return}
  }catch(error){if(error.name!=='AbortError')$('donationReportState').textContent=error.message;return}
  finally{donationReportControls(false)}
  await generateDonationReport();
}
async function generateDonationReport(){
  if(donationReportBusy||!donationReportBounds?.first)return;
  const from=$('donationReportFrom').value,to=$('donationReportTo').value;
  invalidateDonationReport();
  if(!from||!to||from>to||from<donationReportBounds.first||to>donationReportBounds.last){$('donationReportState').textContent='기록된 방송일 범위 안에서 시작일과 종료일을 선택해주세요.';return}
  donationReportControls(true);$('donationReportState').textContent='후원 흐름을 집계하고 있습니다.';
  try{
    const {report}=await requestDonationReport({mode:'report',from,to});
    if(!report?.startCount){$('donationReportState').textContent='선택한 기간에 방송 시작 기록이 없습니다.';return}
    await document.fonts.ready;drawDonationReport(report);donationReportData=report;
    $('donationReportCanvas').classList.remove('hidden');
    const peak=report.peakBin===null?'비교 구간에 저장 후원이 없습니다.':`평균이 가장 높은 구간은 시작 후 ${report.peakBin*30}~${(report.peakBin+1)*30}분입니다.`;
    $('donationReportSummary').textContent=`${from} ~ ${to} · 시작 기록 ${report.startCount}개 중 ${report.comparableCount}개 비교 · ${report.total.toLocaleString()}개. ${peak} 미션 ${report.excluded.missionCount}건은 수락·시각 연결 미확인으로 제외했습니다.`;
    $('donationReportState').textContent='리포트가 준비되었습니다. PNG로 저장할 수 있습니다.';
  }catch(error){if(error.name!=='AbortError')$('donationReportState').textContent=error.message}
  finally{donationReportControls(false)}
}
function drawDonationReport(r){
  // Lay out in readable CSS-sized units; render at 2x for a sharp PNG.
  const width=1200,scale=2,detail=r.sessions.slice(-20),rowHeight=38;
  const chartY=246,chartHeight=Math.max(430,160+r.groups.length*30);
  const heatY=chartY+chartHeight+24,heatHeight=182+Math.max(1,detail.length)*rowHeight;
  const guideY=heatY+heatHeight+24,guideHeight=286,footerY=guideY+guideHeight+36,height=footerY+224;
  const canvas=$('donationReportCanvas');canvas.width=width*scale;canvas.height=height*scale;
  const c=canvas.getContext('2d');c.scale(scale,scale);
  const bg='#09192c',panel='#10263f',fg='#f4f7fc',muted='#c3d1e3',gold='#ffc64c',teal='#79e2d6',grid='#37506b';
  const fmt=n=>Math.round(n).toLocaleString('ko-KR');
  const axis=n=>n>=1e8?(n/1e8).toLocaleString('ko-KR',{maximumFractionDigits:1})+'억':n>=1e4?(n/1e4).toLocaleString('ko-KR',{maximumFractionDigits:1})+'만':fmt(n);
  const cellText=rgb=>{const linear=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*linear[0]+.7152*linear[1]+.0722*linear[2]>.179?'#000000':'#ffffff'};
  const text=(s,x,y,size=18,color=fg,bold=false,align='left')=>{c.font=`${bold?'700':'500'} ${size}px "Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;c.fillStyle=color;c.textAlign=align;c.fillText(String(s),x,y)};
  const card=(x,y,w,h)=>{c.fillStyle=panel;c.beginPath();c.roundRect(x,y,w,h,16);c.fill()};
  const line=(x1,y1,x2,y2,color=grid,lineWidth=1)=>{c.strokeStyle=color;c.lineWidth=lineWidth;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke()};
  c.fillStyle=bg;c.fillRect(0,0,width,height);
  text('별록 · 방송 데이터 리포트',36,44,18,gold,true);
  const name=String(streamerName||'별록');
  text(`${name.length>18?name.slice(0,18)+'…':name} · 방송 시작과 후원 흐름`,36,99,34,fg,true);
  text(`${r.from} — ${r.to}  /  방송 시작일 기준 · 한국 시간`,36,137,19,muted);
  card(28,164,1144,58);
  text(`시작 기록 ${fmt(r.startCount)}개`,50,201,23,fg,true);
  text(`첫 3시간 비교 ${fmt(r.comparableCount)}개`,420,201,23,teal,true);
  text(`별풍선 ${fmt(r.total)}개`,1120,201,23,gold,true,'right');
  card(28,chartY,560,chartHeight);card(612,chartY,560,chartHeight);
  text('방송 시작 후 후원 흐름',52,chartY+42,25,fg,true);
  text('30분별 저장량 · 평균과 중앙값',52,chartY+74,18,muted);
  const x0=100,y0=chartY+chartHeight-88,w=446,h=chartHeight-215,max=Math.max(1,...r.means,...r.medians)*1.15;
  for(let i=0;i<=4;i++){const y=y0-h*i/4;line(x0,y,x0+w,y);text(axis(max*i/4),x0-12,y+6,16,muted,false,'right')}
  const plot=(values,color)=>{c.strokeStyle=color;c.lineWidth=3;c.beginPath();values.forEach((v,i)=>{const x=x0+i*w/5,y=y0-v/max*h;i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();values.forEach((v,i)=>{c.beginPath();c.arc(x0+i*w/5,y0-v/max*h,4,0,Math.PI*2);c.fillStyle=color;c.fill()})};
  plot(r.means,gold);plot(r.medians,teal);
  r.means.forEach((_,i)=>text(`${i*30}–${(i+1)*30}`,x0+i*w/5,y0+30,16,muted,false,'center'));
  text('● 평균',354,chartY+109,17,gold,true);text('● 중앙값',452,chartY+109,17,teal,true);
  text('시작 후 경과 시간(분) · 단위: 개',554,chartY+chartHeight-23,17,muted,false,'right');
  text('시작 시각별 성과',636,chartY+42,25,fg,true);
  text('첫 3시간 합계 · 점: 개별 기록',636,chartY+74,18,muted);
  text('청록선: 중앙값',636,chartY+101,17,teal,true);
  const gx=740,gw=384,gy=chartY+128,gh=chartHeight-207,gmax=Math.max(1,...r.groups.flatMap(g=>g.values))*1.08;
  for(let i=0;i<=3;i++){line(gx+gw*i/3,gy-6,gx+gw*i/3,gy+gh);text(axis(gmax*i/3),gx+gw*i/3,gy+gh+27,16,muted,false,'center')}
  r.groups.forEach((g,i)=>{const y=gy+(i+.5)*gh/Math.max(1,r.groups.length);text(`${g.hour}시 · ${g.count}개`,gx-14,y+6,17,muted,false,'right');g.values.forEach((v,j)=>{c.beginPath();c.arc(gx+v/gmax*gw,y+((j%5)-2)*2,3,0,Math.PI*2);c.fillStyle=g.count<3?'#aabbd0':gold;c.fill()});const x=gx+g.median/gmax*gw;line(x,y-8,x,y+8,teal,3)});
  if(!r.groups.length)text('비교 가능한 시작 기록이 없습니다.',636,gy+80,18,muted);
  text('표본이 적은 시간대는 성과를 단정하기 어렵습니다.',636,chartY+chartHeight-23,17,muted);
  card(28,heatY,1144,heatHeight);
  text('시작 기록별 후원 분포',52,heatY+42,25,fg,true);
  text(`전체 ${r.startCount}개 중 최근 ${detail.length}개 표시 · 전체 집계에는 모든 비교 기록 사용`,52,heatY+74,18,muted);
  const hx=244,cw=148,hy=heatY+126,maxCell=Math.max(1,...detail.flatMap(s=>s.bins));
  text('방송 시작',hx-20,hy-16,17,muted,true,'right');
  for(let j=0;j<6;j++)text(`${j*30}–${(j+1)*30}분`,hx+j*cw+cw/2,hy-16,17,muted,true,'center');
  detail.forEach((s,i)=>{const y=hy+i*rowHeight;text(s.start.slice(5,10)+' '+s.start.slice(11,16)+(s.eligible?'':' *'),hx-20,y+25,17,muted,true,'right');s.bins.forEach((v,j)=>{const partial=(j+1)*30>s.availableMinutes,t=Math.sqrt(v/maxCell),rgb=[Math.round(16+239*t),Math.round(38+160*t),Math.round(63+13*t)];c.fillStyle=partial?'#394b61':`rgb(${rgb.join(',')})`;c.fillRect(hx+j*cw,y,cw-3,rowHeight-3);text(partial?'—':fmt(v),hx+j*cw+cw/2,y+25,18,partial?fg:cellText(rgb),true,'center')})});
  if(!detail.length)text('선택 기간에 표시할 기록이 없습니다.',52,hy+25,18,muted);
  text('0: 저장 후원 없음   회색·*: 다음 시작과 겹치는 구간   색 농도: 제곱근 척도',52,heatY+heatHeight-22,17,muted);
  card(28,guideY,1144,guideHeight);text('리포트 읽는 법',52,guideY+42,25,fg,true);
  if(r.peakBin!==null){const p=r.peakBin;text('평균이 가장 높은 구간',52,guideY+85,18,muted);text(`시작 후 ${p*30}–${(p+1)*30}분`,52,guideY+124,28,gold,true);text(`평균 ${fmt(r.means[p])}개 / 중앙값 ${fmt(r.medians[p])}개`,52,guideY+158,19,fg)}
  else text('비교 구간에 저장 후원이 없습니다.',52,guideY+112,19,muted);
  text('큰 후원은 평균을 끌어올릴 수 있습니다.',52,guideY+204,19);text('중앙값과 개별 기록도 함께 확인하세요.',52,guideY+237,19);
  text(`다음 시작과 겹친 기록 ${r.overlapCount}개`,636,guideY+85,20,teal,true);text('첫 3시간 성과 비교에서 제외했습니다.',636,guideY+116,18,muted);
  text(`미션 ${r.excluded.missionCount}건 · ${fmt(r.excluded.missionAmount)}개 제외`,636,guideY+162,20,gold,true);text('최종 수락과 원 후원 시각 연결 미확인',636,guideY+193,18,muted);
  text('방송시간당 효율·최적 시작 시각을 확정하지 않습니다.',636,guideY+242,17,muted);
  text(`분석 범위: 일반·별풍선·룰렛·영상후원 / 비교 구간 ${fmt(r.count)}건`,36,footerY,18,muted);
  text(`제외: 구독 ${r.excluded.subscriptionCount}건·미상 유형 ${r.excluded.unknownCount}건 / 첫 3시간 미연결 ${fmt(r.excluded.unassignedCount)}건 / 날짜·금액 오류 ${fmt(r.excluded.invalidCount)}건`,36,footerY+32,18,muted);
  text('시작 기록은 독립된 방송 횟수와 다를 수 있습니다. 방송 종료·수집 연속성은 확인되지 않았습니다.',36,footerY+78,18,muted);
  text('선은 30분 집계값을 연결합니다. 요일·콘텐츠·수집 공백은 보정하지 않았습니다.',36,footerY+110,18,muted);
  text('작은 표본의 성과를 다음 방송의 예측이나 시작 시간 추천으로 해석하지 마세요.',36,footerY+142,18,muted);
  text(`생성: ${new Date(r.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})} KST · BYEOLLOG`,36,footerY+190,17,muted);
}
async function downloadDonationReport(){
  if(!donationReportData||donationReportBusy)return;
  const report=donationReportData;donationReportControls(true);
  try{const blob=await new Promise(resolve=>$('donationReportCanvas').toBlob(resolve,'image/png'));if(!blob)throw Error('이미지를 만들지 못했습니다. 다시 시도해주세요.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`별풍선-리포트-${report.from}-${report.to}.png`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
  catch(error){$('donationReportState').textContent=error.message}
  finally{donationReportControls(false)}
}
