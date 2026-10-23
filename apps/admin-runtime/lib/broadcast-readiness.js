// A bounded read-only snapshot. Missing observations must not become success.
export async function broadcastReadiness({sb,workspaceId,userId,now=Date.now()}){
  const filter=encodeURIComponent(workspaceId),timeout=()=>AbortSignal.timeout(6000);
  const queries={
    connection:()=>sb('byeollog_soop_connections',`?workspace_id=eq.${filter}&select=status&limit=1`,{signal:timeout()}),
    devices:()=>sb('rpc/byeollog_broadcast_agent_readiness_v1','',{method:'POST',body:{p_workspace_id:workspaceId},signal:timeout()}),
    upbo:()=>sb('rpc/byeollog_upbo_collection_settings_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId,p_request:{action:'get'}},signal:timeout()}),
    gateway:()=>sb('byeollog_soop_gateway_sessions',`?workspace_id=eq.${filter}&select=state,heartbeat_at&limit=1`,{signal:timeout()})
  };
  const entries=Object.entries(queries),values=await Promise.allSettled(entries.map(([,run])=>Promise.resolve().then(run)));
  const data=Object.fromEntries(entries.map(([key],i)=>[key,values[i].status==='fulfilled'&&(['devices','upbo'].includes(key)?values[i].value&&typeof values[i].value==='object':Array.isArray(values[i].value))?values[i].value:null]));
  const fresh=value=>{const time=Date.parse(value||'');return Number.isFinite(time)&&now-time>=-30000&&now-time<=120000};
  const gateway=data.gateway?.[0],connection=data.connection?.[0];
  return {ok:true,checkedAt:new Date(now).toISOString(),scope:workspaceId+':'+userId,
    connection:data.connection===null?{state:'unknown'}:{state:connection?.status==='connected'?'connected':connection?.status==='reauthorization_required'?'reconnect':'missing'},
    agent:data.devices&&['online','offline','missing'].includes(data.devices.state)?{state:data.devices.state,registered:data.devices.registered,online:data.devices.online}:{state:'unknown'},
    upbo:!data.upbo||typeof data.upbo.enabled!=='boolean'||typeof data.upbo.url!=='string'?{state:'unknown'}:{state:data.upbo.enabled&&data.upbo.url.trim()?'enabled':data.upbo.enabled?'needs_setup':'off',hasUrl:Boolean(data.upbo.url.trim())},
    collection:data.gateway===null?{state:'unknown'}:{state:gateway?.state==='connected'&&fresh(gateway.heartbeat_at)?'connected':'waiting'},
    wallpaper:{url:'http://127.0.0.1:43120/overlay/wallpaper',displayConfirmed:false}
  };
}
