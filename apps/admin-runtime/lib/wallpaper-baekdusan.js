// Read-only, behind authorizedAgentWorkspace. Never accept a workspace from the
// control payload. Cursor order is the ledger's receipt sequence, not UI order.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:'invalid_baekdusan_request'});
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export async function readBaekdusanLog(workspaceId,body,sb,signal){
  const {sessionId,afterSequence=0,amount=null,tileId=null}=body;
  if(!UUID.test(workspaceId)||!UUID.test(sessionId||'')||!integer(afterSequence,0,Number.MAX_SAFE_INTEGER)
    ||(amount!==null&&!integer(amount,1,1_000_000))||(tileId!==null&&!UUID.test(tileId)))throw fail('백두산 조회 정보가 올바르지 않습니다.');
  const scope=`workspace_id=eq.${workspaceId}&session_id=eq.${sessionId}`;
  const sessions=await sb('byeollog_wallpaper_sessions',`?workspace_id=eq.${workspaceId}&id=eq.${sessionId}&select=id,state,started_at,closed_at&limit=1`,{signal});
  if(!sessions?.length)throw fail('이 계정의 방송 기록을 찾을 수 없습니다.',404);
  // Start selection and live replay use the same stable order. Only plain
  // balloon cards qualify; subscription/challenge-success counts are not tips.
  const rows=await sb('byeollog_wallpaper_tiles',`?${scope}&display_kind=eq.donation&sequence_no=gt.${afterSequence}`
    +(amount===null?'':`&amount=eq.${amount}`)+(tileId===null?'':`&id=eq.${tileId}`)
    +'&select=id,session_id,sequence_no,actor_name,amount,received_at&order=sequence_no.asc&limit=201',{signal});
  const page=(rows||[]).slice(0,200);
  const tiles=page.map(row=>{
    const sequenceNo=Number(row.sequence_no);
    if(!integer(sequenceNo,1,Number.MAX_SAFE_INTEGER))throw fail('후원 기록 순서를 안전하게 읽을 수 없습니다.',500);
    return {id:row.id,sessionId:row.session_id,sequenceNo,actorName:String(row.actor_name||'익명').slice(0,120),amount:Number(row.amount),receivedAt:row.received_at};
  });
  return {ok:true,sessionId,closed:sessions[0].state==='closed',tiles,hasMore:rows.length>200,nextSequence:tiles.at(-1)?.sequenceNo??afterSequence};
}
