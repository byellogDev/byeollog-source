// A checkpoint is reusable only while no retained wallpaper row can expire.
export function nextRetentionReviewAt(backup,now=Date.now()){
  const times=[];
  for(const row of backup.tables?.byeollog_wallpaper_tiles||[])times.push(Date.parse(row.received_at));
  for(const row of backup.tables?.byeollog_wallpaper_sessions||[])if(row.state==='closed')times.push(Date.parse(row.closed_at));
  if(times.some(t=>!Number.isFinite(t)))return now;
  return times.reduce((at,t)=>Math.min(at,t+7*86400000),now+86400000);
}
