import {createPublicKey,verify} from 'node:crypto';
export const OPS_GUILD='1547124331757305856';
export const OPS_CHANNEL='1547124495465185290';
export const OPS_COMMANDS=Object.freeze([
 {name:'상태',description:'별록 웹·DB·수집·백업의 최근 감시 상태'},
 {name:'수집',description:'수집 연결·대기·격리 건수와 최근 이벤트 시각'},
 {name:'백업',description:'최근 독립 백업의 완료·실패·갱신 상태'},
 {name:'자원',description:'CPU·메모리·디스크와 DB 연결·사용 용량'}
].map(c=>Object.freeze({...c,type:1,default_member_permissions:'8'})));
const names=new Set(OPS_COMMANDS.map(c=>c.name));
const snowflake=/^[0-9]{17,20}$/;
const shortNumber=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n.toLocaleString('ko-KR',{maximumFractionDigits:1}):'확인 불가';
const iso=v=>{const d=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(d)?d:null};
const time=v=>iso(v)!==null?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v))+' KST':'확인 불가';
const age=(v,now)=>iso(v)===null?Infinity:(now-iso(v))/1000;
const fresh=(v,limit,now)=>age(v,now)>=-30&&age(v,now)<=limit;
const percent=v=>typeof v==='number'?shortNumber(v)+'%':'확인 불가';
const mb=v=>typeof v==='number'?shortNumber(v/1048576)+' MiB':'확인 불가';
const labels={supabase:'DB 감시 조회 실패',website:'웹 응답 이상',health_stale:'서버 점검 기록 중단',backup_failed:'백업 실패·미완료',backup_stale:'백업 갱신 지연',cpu:'CPU 사용률 상승',db_space:'DB 용량 상승',storage_space:'파일 용량 상승',queued_actions:'실행 대기 누적',retry_actions:'실행 재시도 누적',db_alert_failed:'알림 전달 실패',disk:'디스크 사용률 상승',memory:'가용 메모리 부족',pids:'프로세스 한도 접근',queue:'전송 대기 누적',delivery_age:'전송 지연',memory_queue:'메모리 대기 누적',container:'수집기 상태 이상',worker_heartbeat:'수집기 상태 갱신 중단',quarantined_events:'격리된 전송 기록',memory_queue_age:'메모리 대기 지연',flush_stalled:'전송 진행 중단',channel_state:'채널 연결 오류'};
const ephemeral=content=>({content,flags:64,allowed_mentions:{parse:[]}});
export function discordSignatureValid({publicKey,signature,timestamp,raw,now=Date.now()}){
 if(!/^[a-f0-9]{64}$/i.test(publicKey||'')||!/^[a-f0-9]{128}$/i.test(signature||'')||!/^\d{10,11}$/.test(timestamp||'')||Math.abs(now/1000-Number(timestamp))>300||!Buffer.isBuffer(raw))return false;
 try{return verify(null,Buffer.concat([Buffer.from(timestamp),raw]),createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey,'hex')]),format:'der',type:'spki'}),Buffer.from(signature,'hex'))}catch{return false}
}
export function validateOpsInteraction(data,applicationId){
 if(!data||typeof data!=='object'||data.application_id!==applicationId)return '잘못된 앱 요청입니다.';
 if(data.type===1)return null;
 if(data.type!==2||data.data?.type!==1||!names.has(data.data?.name)||data.data?.options?.length)return '지원하지 않는 명령입니다.';
 if(data.guild_id!==OPS_GUILD||data.channel_id!==OPS_CHANNEL)return '지정된 운영 서버의 서비스장애알림 채널에서 사용해주세요.';
 if(!snowflake.test(data.member?.user?.id||'')||!/^\d{1,24}$/.test(data.member?.permissions||''))return '서버 관리자만 사용할 수 있습니다.';
 if((BigInt(data.member.permissions)&8n)!==8n)return '서버 관리자만 사용할 수 있습니다.';
 if(!snowflake.test(data.id||'')||typeof data.token!=='string'||!/^[A-Za-z0-9._-]{20,512}$/.test(data.token))return '잘못된 명령 요청입니다.';
 return null;
}
export function formatOpsStatus(command,result,{now=Date.now(),failed=false}={}){
 if(failed)return ephemeral('⚠️ 별록 상태 조회 실패\n명령 수신 서버는 응답했지만 DB 감시 자료를 읽지 못했습니다. 정상으로 판단할 수 없습니다. 잠시 후 다시 조회해주세요.');
 const snap=result?.snapshot,p=snap?.payload||{},s=p.sample||{},notes=Array.isArray(p.bad)?p.bad.filter(k=>Object.hasOwn(labels,k)):[];
 if(!snap)return ephemeral('⚠️ 아직 감시 자료가 없습니다.\n명령 수신 서버와 DB 조회는 응답했습니다. NCP 감시 자료가 도착한 뒤 다시 조회해주세요.');
 const current=fresh(snap.measuredAt,360,now)&&fresh(snap.receivedAt,360,now),host=current&&fresh(s.healthAt,540,now),web=current&&fresh(s.websiteCheckedAt,720,now),backup=current&&fresh(s.backupAt,108000,now),usage=fresh(p.usageAt,7200,now);
 let title=!current?'⚠️ 최신 상태 확인 불가':notes.length?'⚠️ 점검 필요':'🟢 감시 이상 징후 없음';
 const complete=host&&web&&backup&&s.websiteStatus===200&&s.container==='running:healthy'&&s.backupFailed===0&&Number.isInteger(s.backupTargets)&&s.backupTargets>0&&s.backupCompleted===s.backupTargets;
 if(current&&!complete)title='⚠️ 일부 상태 확인 필요';
 const lines=['**별록 /'+command+' · '+title+'**','감시 측정: '+time(snap.measuredAt)];
 if(!current)lines.push('마지막 감시 자료가 6분 이상 지났거나 시각이 유효하지 않습니다. 아래 수치는 과거 기록입니다.');
 if(command==='상태'){
  lines.push('웹: '+(!web?'최신 확인 불가':s.websiteStatus===200?'최근 HTTP 200':'응답 이상 ('+shortNumber(s.websiteStatus)+')'));
  lines.push('DB: 현재 감시 자료 조회 응답 · 측정 당시 연결 '+shortNumber(p.dbConnections)+'개');
  lines.push('수집기: '+(!host?'최신 확인 불가':s.container==='running:healthy'?'실행·상태 점검 정상':'확인 필요'));
  lines.push('독립 백업: '+(!backup?'최신 확인 불가':shortNumber(s.backupCompleted)+' / '+shortNumber(s.backupTargets)+'개 완료 · 실패 '+shortNumber(s.backupFailed)+'개'));
 }else if(command==='수집'){
  lines.push('서버 상태 측정: '+time(s.healthAt));
  if(!host)lines.push('⚠️ 수집기 세부 기록의 최신 상태를 확인할 수 없습니다.');
  lines.push('감시 채널 '+shortNumber(s.channelCount)+'개 · 연결된 방송 '+shortNumber(s.liveChannels)+'개');
  lines.push('전송 대기 '+shortNumber(s.pending)+'건 · 메모리 대기 '+shortNumber(s.memoryPending)+'건');
  lines.push('가장 오래된 전송 대기 '+shortNumber(s.oldestAgeSeconds)+'초');
  lines.push('채널 오류 '+shortNumber(s.channelErrors)+'개 · 격리 '+shortNumber(s.deadLetters)+'건 · 손상 '+shortNumber(s.corrupt)+'건');
  lines.push('최근 SDK 이벤트: '+time(s.lastEventAt),'최근 서버 전송: '+time(s.lastDeliveryAt));
  lines.push('방송·이벤트가 없으면 최근 수신 시각이 오래될 수 있습니다.');
 }else if(command==='백업'){
  lines.push('백업 실행 기록: '+time(s.backupAt));
  if(!backup)lines.push('⚠️ 최근 30시간 내 백업 실행 기록을 확인하지 못했습니다.');
  lines.push('완료 '+shortNumber(s.backupCompleted)+' / '+shortNumber(s.backupTargets)+'개 · 실패 '+shortNumber(s.backupFailed)+'개');
  lines.push('가장 오래된 보관 사본: '+(typeof s.oldestBackupAgeSeconds==='number'?shortNumber((s.oldestBackupAgeSeconds+Math.max(0,age(snap.measuredAt,now)))/3600)+'시간 전':'확인 불가'));
  lines.push('백업 성공 기록이며, 현재 복원 시험을 실행한 결과는 아닙니다.');
 }else if(command==='자원'){
  if(!host)lines.push('⚠️ 서버 세부 측정의 최신 상태를 확인할 수 없습니다.');
  lines.push('CPU '+percent(s.cpuPercent)+' · 가용 메모리 '+percent(s.memoryAvailablePercent)+' · 디스크 사용 '+percent(s.diskPercent));
  lines.push('수집기 프로세스 '+shortNumber(s.pids)+' / '+shortNumber(s.pidLimit));
  lines.push('DB 연결 '+shortNumber(p.dbConnections)+'개 · 활성 '+shortNumber(p.dbActive)+'개');
  lines.push('DB '+mb(p.usage?.databaseBytes)+' · 파일 '+mb(p.usage?.storageBytes));
  lines.push('용량 측정: '+time(p.usageAt)+(usage?'':' · 오래되었거나 확인 불가'));
  lines.push('월간 청구 금액·남은 요금제 한도는 이 수치에 포함되지 않습니다.');
 }
 if(notes.length)lines.push('감시 항목: '+[...new Set(notes)].map(k=>labels[k]).join(' · '));
 lines.push('운영자 전용 · 측정값 조회만 수행');return ephemeral(lines.join('\n').slice(0,1950));
}
export function createOpsLimiter(){const users=new Map(),seen=new Map();return (user,id,now=Date.now())=>{for(const [k,t]of seen)if(t<now-300000)seen.delete(k);for(const[k,t]of users)if(t<now-60000)users.delete(k);if(seen.has(id))return false;if(users.size>=500||seen.size>=1000||now-(users.get(user)||0)<5000)return false;users.set(user,now);seen.set(id,now);return true}}
export {ephemeral};
