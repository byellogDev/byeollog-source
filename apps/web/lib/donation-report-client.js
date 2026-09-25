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
  const canvas=$('donationReportCanvas');canvas.width=2400;canvas.height=2440;const c=canvas.getContext('2d');
  const bg='#09192c',panel='#10263f',fg='#f1f5fc',muted='#a5b8cf',gold='#ffc64c',teal='#68d4c8';
  const fmt=n=>Math.round(n).toLocaleString('ko-KR');
  const text=(s,x,y,size=25,color=fg,bold=false,align='left',maxWidth)=>{c.font=`${bold?'700':'400'} ${size}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;c.fillStyle=color;c.textAlign=align;c.fillText(String(s),x,y,maxWidth)};
  const card=(x,y,w,h)=>{c.fillStyle=panel;c.beginPath();c.roundRect(x,y,w,h,22);c.fill()};
  const line=(x1,y1,x2,y2,color,width=1)=>{c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke()};
  c.fillStyle=bg;c.fillRect(0,0,2400,2440);
  text('BYEOLLOG / DONATION REPORT',110,105,23,gold,true);
  text(`${String(streamerName||'별록').slice(0,40)} · 방송 시작과 후원 흐름`,110,195,57,fg,true,'left',2180);
  text(`${r.from} — ${r.to}  |  방송 시작일 기준 · 한국 시간(KST)`,110,255,28,muted);
  card(100,300,2200,130);text(`시작 기록 ${fmt(r.startCount)}개`,145,380,35,fg,true);text(`첫 3시간 비교 ${fmt(r.comparableCount)}개`,790,380,35,teal,true);text(`별풍선 ${fmt(r.total)}개`,1660,380,35,gold,true);
  card(100,470,1060,630);card(1200,470,1100,630);
  text('01  방송 시작 후 후원 흐름',145,540,33,fg,true);text('30분별 저장량 · 평균과 중앙값',145,585,24,muted);
  const x0=210,y0=980,w=850,h=315,max=Math.max(1,...r.means,...r.medians)*1.15;
  for(let i=0;i<=4;i++){const y=y0-h*i/4;line(x0,y,x0+w,y,'#294057');text(fmt(max*i/4),x0-18,y+8,20,muted,false,'right')}
  const plot=(values,color)=>{c.strokeStyle=color;c.lineWidth=5;c.beginPath();values.forEach((v,i)=>{const x=x0+i*w/5,y=y0-v/max*h;i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();values.forEach((v,i)=>{c.beginPath();c.arc(x0+i*w/5,y0-v/max*h,7,0,Math.PI*2);c.fillStyle=color;c.fill()})};
  plot(r.means,gold);plot(r.medians,teal);
  r.means.forEach((_,i)=>text(`${i*30}–${(i+1)*30}`,x0+i*w/5,y0+40,19,muted,false,'center'));
  text('● 평균',775,624,22,gold);text('● 중앙값',930,624,22,teal);text('시작 후 경과 시간(분) · 단위: 개',1080,1060,23,muted,false,'right');
  text('02  시작 시각별 성과',1245,540,33,fg,true);text('첫 3시간 합계 · 점=개별 기록 / 청록선=중앙값',1245,585,23,muted);
  const gx=1460,gw=715,gy=650,gh=365,gmax=Math.max(1,...r.groups.flatMap(g=>g.values))*1.06;
  for(let i=0;i<=3;i++){line(gx+gw*i/3,gy-15,gx+gw*i/3,gy+gh,'#294057');text(fmt(gmax*i/3),gx+gw*i/3,gy+gh+35,18,muted,false,'center')}
  r.groups.forEach((g,i)=>{const y=gy+(i+.5)*gh/Math.max(1,r.groups.length);text(`${g.hour}시 · ${g.count}개`,gx-25,y+7,19,muted,false,'right');g.values.forEach((v,j)=>{c.beginPath();c.arc(gx+v/gmax*gw,y+((j%5)-2)*3,5,0,Math.PI*2);c.fillStyle=g.count<3?'#8094ac':gold;c.fill()});const x=gx+g.median/gmax*gw;line(x,y-10,x,y+10,teal,5)});
  if(!r.groups.length)text('비교 가능한 시작 기록이 없습니다.',1750,825,27,muted,false,'center');
  text('표본이 적은 시간은 최적 시작 시각으로 단정할 수 없습니다.',1245,1080,21,muted);
  card(100,1140,1430,930);card(1570,1140,730,930);
  const detail=r.sessions.slice(-20),maxCell=Math.max(1,...detail.flatMap(s=>s.bins));
  text('03  시작 기록별 후원 분포',145,1210,33,fg,true);text(`전체 ${r.startCount}개 중 최근 ${detail.length}개 표시 · 전체 집계는 모든 비교 기록 사용`,145,1255,23,muted);
  const hy=1310,rh=29,hx=440,cw=165;
  detail.forEach((s,i)=>{const y=hy+i*rh;text(s.start.slice(5,10)+' '+s.start.slice(11,16)+(s.eligible?'':' *'),hx-20,y+22,18,muted,false,'right');s.bins.forEach((v,j)=>{const partial=(j+1)*30>s.availableMinutes,t=Math.sqrt(v/maxCell);c.fillStyle=partial?'#3b4552':`rgb(${Math.round(16+239*t)},${Math.round(38+160*t)},${Math.round(63+13*t)})`;c.fillRect(hx+j*cw,y,cw-3,rh-2);text(partial?'—':fmt(v),hx+j*cw+cw/2,y+21,18,t>.6&&!partial?bg:fg,false,'center')})});
  for(let j=0;j<6;j++)text(`${j*30}–${(j+1)*30}분`,hx+j*cw+cw/2,hy+detail.length*rh+35,19,muted,false,'center');
  text('0 = 저장 후원 없음 · 회색 = 다음 시작과 겹치는 구간',145,1975,22,muted);text('색 농도는 제곱근 척도입니다. 실제 값은 숫자로 표시합니다.',145,2020,22,muted);
  text('리포트 읽는 법',1615,1210,33,fg,true);
  if(r.peakBin!==null){const p=r.peakBin;text('평균이 가장 높은 구간',1615,1280,24,muted);text(`시작 후 ${p*30}–${(p+1)*30}분`,1615,1340,36,gold,true);text(`평균 ${fmt(r.means[p])}개 / 중앙값 ${fmt(r.medians[p])}개`,1615,1390,24,fg)}
  else{text('비교 구간에 저장 후원이 없습니다.',1615,1320,26,muted)}
  text('큰 후원이 평균을 끌어올릴 수 있습니다.',1615,1470,24);text('중앙값과 개별 기록도 함께 확인하세요.',1615,1510,24);
  text(`다음 시작과 겹친 기록 ${r.overlapCount}개`,1615,1600,27,teal,true);text('첫 3시간 성과 비교에서 제외했습니다.',1615,1640,23,muted);
  text(`미션 ${r.excluded.missionCount}건 · ${fmt(r.excluded.missionAmount)}개 제외`,1615,1730,26,gold,true);text('최종 수락과 원 후원 시각 연결 미확인',1615,1770,23,muted);
  text('방송시간당 효율·최적 시작 시각을',1615,1860,24);text('확정하는 자료는 아닙니다.',1615,1900,24);text('요일·콘텐츠·수집 공백은 미보정입니다.',1615,1950,22,muted);
  text(`분석 범위  일반·별풍선·룰렛·영상후원 / 비교 구간 ${fmt(r.count)}건 / 구독 ${r.excluded.subscriptionCount}건·미상 유형 ${r.excluded.unknownCount}건 제외`,110,2150,24,muted);
  text(`기간 내 첫 3시간에 연결되지 않은 기록 ${fmt(r.excluded.unassignedCount)}건 · 유효하지 않은 날짜/금액 ${fmt(r.excluded.invalidCount)}건`,110,2200,23,muted);
  text('시작 기록은 독립된 방송 횟수와 다를 수 있습니다. 0은 저장 후원 없음이며, 방송 종료와 수집 연속성은 확인되지 않았습니다.',110,2260,23,muted);
  text('선은 30분 집계값을 연결한 것입니다. 작은 표본의 성과를 다음 방송의 예측이나 시작 시간 추천으로 해석하지 마세요.',110,2310,23,muted);
  text(`생성: ${new Date(r.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})} KST · BYEOLLOG`,110,2375,22,muted);
}
async function downloadDonationReport(){
  if(!donationReportData||donationReportBusy)return;
  const report=donationReportData;donationReportControls(true);
  try{const blob=await new Promise(resolve=>$('donationReportCanvas').toBlob(resolve,'image/png'));if(!blob)throw Error('이미지를 만들지 못했습니다. 다시 시도해주세요.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`별풍선-리포트-${report.from}-${report.to}.png`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
  catch(error){$('donationReportState').textContent=error.message}
  finally{donationReportControls(false)}
}
