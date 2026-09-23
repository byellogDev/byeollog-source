import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';
import {loadWallpaperState} from './wallpaper-service.js';
import {
  WALLPAPER_CANVAS_HEIGHT,WALLPAPER_CANVAS_WIDTH,
  WALLPAPER_EDITOR_MARGIN_X,WALLPAPER_EDITOR_MARGIN_Y
} from './wallpaper-layout.js';

export const AGENT_WALLPAPER_LAYOUT_PROTOCOL=3;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const writes=new Map();

function serialize(workspaceId,payload,write){
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
  const active=writes.get(workspaceId);
  if(active?.fingerprint===fingerprint)return active.promise;
  const promise=Promise.resolve(active?.promise).catch(()=>{}).then(write);
  const entry={fingerprint,promise};writes.set(workspaceId,entry);
  return promise.finally(()=>{if(writes.get(workspaceId)===entry)writes.delete(workspaceId)});
}

function abortable(promise,signal){
  if(!signal)return promise;
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(signal.reason||Object.assign(new Error('request aborted'),{name:'AbortError'}));
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(promise).then(
      value=>{signal.removeEventListener('abort',aborted);resolve(value)},
      error=>{signal.removeEventListener('abort',aborted);reject(error)}
    );
  });
}

function invalid(message,code='invalid_wallpaper_request',status=400){
  return Object.assign(new Error(message),{code,status});
}

export async function runAgentWallpaperControl({workspaceId,userId,body=null,signal=null,onStage=()=>{},sbImpl=sb,loadStateImpl=loadWallpaperState}){
  signal?.throwIfAborted();
  if(body?.action==='verify-cache-ownership')return verifyWallpaperCacheOwnership(workspaceId,body.tileIds,sbImpl,signal);
  if(body){
    const payload={userId,body};
    return abortable(serialize(workspaceId,payload,()=>{
      signal?.throwIfAborted();
      return runAgentWallpaperControlWrite({workspaceId,userId,body,signal,onStage,sbImpl,loadStateImpl});
    }),signal);
  }
  return abortable(loadAgentWallpaperResponse({workspaceId,userId,signal,onStage,sbImpl,loadStateImpl}),signal);
}

// Caller authenticates the Agent and workspace membership before this read.
// Return only a boolean, never any other workspace's records or identifiers.
export async function verifyWallpaperCacheOwnership(workspaceId,tileIds,sbImpl=sb,signal=null){
  if(!UUID.test(workspaceId)||!Array.isArray(tileIds)||tileIds.length<1||tileIds.length>864
    ||tileIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw invalid('캐시 확인 정보가 올바르지 않습니다.');
  const ids=[...new Set(tileIds.map(id=>id.toLowerCase()))];
  for(let offset=0;offset<ids.length;offset+=100){
    const batch=ids.slice(offset,offset+100);
    const options=signal?{signal}:undefined;
    const rows=await sbImpl('byeollog_wallpaper_tiles',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=in.(${batch.join(',')})&select=id&limit=100`,options);
    const owned=new Set((rows||[]).map(row=>row.id));
    if(batch.some(id=>!owned.has(id)))return {owned:false,workspaceId};
  }
  return {owned:true,workspaceId};
}

async function runAgentWallpaperControlWrite({workspaceId,userId,body,signal,onStage,sbImpl,loadStateImpl}){
  let committedRevision=null;
  const mutate=async(...args)=>{
    const result=await sbImpl(...args);
    if((typeof result==='number'||typeof result==='string')&&Number.isSafeInteger(Number(result))&&Number(result)>=0)committedRevision=Number(result);
    return result;
  };
  if(body){
    const action=String(body.action||'');
    onStage(`mutation:${action||'unknown'}`);
    if(action==='reset'){
      await mutate('rpc/rotate_wallpaper_session_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId}});
    }else if(action==='select-sessions'){
      const sessionIds=Array.isArray(body.sessionIds)?body.sessionIds.map(value=>String(value||'').trim().toLowerCase()):[];
      if(sessionIds.length>20||sessionIds.some(id=>!UUID.test(id))||new Set(sessionIds).size!==sessionIds.length)throw invalid('방송 회차 선택 정보가 올바르지 않습니다.');
      await mutate('rpc/select_wallpaper_sessions_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_session_ids:sessionIds}});
    }else if(action==='save-layout'){
      if(Number(body.layoutSaveProtocol)!==AGENT_WALLPAPER_LAYOUT_PROTOCOL)throw invalid('풍벽지 편집기를 업데이트해주세요.','wallpaper_editor_upgrade_required',428);
      const expectedRevision=Number(body.expectedRevision),tiles=Array.isArray(body.tiles)?body.tiles:[];
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||tiles.length>216)throw invalid('풍벽지 배치 정보가 올바르지 않습니다.');
      const normalized=[];
      for(const tile of tiles){
        const id=String(tile?.id||'').trim().toLowerCase(),nextSide=tile?.nextSide==='left'?'left':tile?.nextSide==='right'?'right':null;
        const values=['x','y','width','height','columns','rows','layer'].map(key=>Number(tile?.[key]));
        if(!UUID.test(id)||!nextSide||!values.every(Number.isSafeInteger)
          ||values[0]<-WALLPAPER_EDITOR_MARGIN_X||values[1]<-WALLPAPER_EDITOR_MARGIN_Y||values[2]<80||values[3]<60
          ||values[0]+values[2]>WALLPAPER_CANVAS_WIDTH+WALLPAPER_EDITOR_MARGIN_X
          ||values[1]+values[3]>WALLPAPER_CANVAS_HEIGHT+WALLPAPER_EDITOR_MARGIN_Y
          ||values[4]<1||values[4]>217||values[5]<1||values[5]>216||values[6]<1||values[6]>216)throw invalid('풍벽지 카드가 편집 가능 영역을 벗어났습니다.');
        normalized.push({id,x:values[0],y:values[1],width:values[2],height:values[3],columns:values[4],rows:values[5],layer:values[6],next_side:nextSide});
      }
      if(new Set(normalized.map(tile=>tile.id)).size!==normalized.length)throw invalid('중복된 풍벽지 카드가 있습니다.');
      const payload={p_workspace_id:workspaceId,p_authorized_user_id:userId,p_expected_revision:expectedRevision,p_protocol:AGENT_WALLPAPER_LAYOUT_PROTOCOL,p_tiles:normalized};
      await mutate('rpc/save_wallpaper_overlay_layout_v4','',{method:'POST',signal,body:payload});
    }else if(action==='save-visibility'){
      const expectedRevision=Number(body.expectedRevision),visibleKeys=Array.isArray(body.visibleKeys)?[...new Set(body.visibleKeys.map(value=>String(value||'').trim()))].sort():[];
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||visibleKeys.length>500||visibleKeys.some(key=>!/^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$/.test(key)))throw invalid('풍벽지 표시 목록이 올바르지 않습니다.');
      await mutate('rpc/save_wallpaper_visible_keys_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_expected_revision:expectedRevision,p_visible_keys:visibleKeys}});
    }else if(action==='save-merge-rules'||action==='save-size-rules'){
      const expectedRevision=Number(body.expectedRevision),isSize=action==='save-size-rules',source=Array.isArray(isSize?body.sizeRules:body.mergeRules)?(isSize?body.sizeRules:body.mergeRules):[];
      const rules=source.map(item=>({min:Number(item?.min),max:Number(item?.max),...(isSize?{width:Number(item?.width)}:{})})).sort((a,b)=>a.min-b.min||a.max-b.max);
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||rules.length>20||rules.some((item,index)=>!Number.isSafeInteger(item.min)||!Number.isSafeInteger(item.max)||item.min<1||item.max<item.min||item.max>1_000_000||(isSize&&(!Number.isSafeInteger(item.width)||item.width<80||item.width>480))||(index>0&&item.min<=rules[index-1].max)))throw invalid(isSize?'풍벽지 크기 범위가 올바르지 않습니다.':'풍벽지 합병 범위가 올바르지 않습니다.');
      if(isSize&&Object.hasOwn(body,'layoutTiles')){
        if(Number(body.layoutSaveProtocol)!==AGENT_WALLPAPER_LAYOUT_PROTOCOL||!Array.isArray(body.layoutTiles)||body.layoutTiles.length>216)throw invalid('풍벽지 배치 정보가 올바르지 않습니다.');
        const tiles=body.layoutTiles.map(tile=>({...tile,next_side:tile.nextSide}));
        await mutate('rpc/save_wallpaper_size_and_layout_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_expected_revision:expectedRevision,p_size_ranges:rules,p_protocol:AGENT_WALLPAPER_LAYOUT_PROTOCOL,p_tiles:tiles}});
      }else await mutate(isSize?'rpc/save_wallpaper_size_rules_v1':'rpc/save_wallpaper_merge_rules_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_expected_revision:expectedRevision,[isSize?'p_size_ranges':'p_merge_ranges']:rules}});
    }else if(action==='auto-arrange'){
      const expectedRevision=Number(body.expectedRevision);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw invalid('풍벽지 회차 정보가 올바르지 않습니다.');
      await mutate('rpc/clear_wallpaper_overlay_layout_v1','',{method:'POST',signal,body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_expected_revision:expectedRevision}});
    }else throw invalid('풍벽지 요청이 올바르지 않습니다.');
  }
  const receipt={ok:true,committed:true,revision:committedRevision};
  if(body?.responseMode==='receipt'&&body.action==='save-layout'&&committedRevision!==null)return receipt;
  try{return await loadAgentWallpaperResponse({workspaceId,userId,signal,onStage,sbImpl,loadStateImpl})}
  catch(error){
    if(body?.responseMode==='state-or-receipt'&&committedRevision!==null)return {...receipt,refreshPending:true};
    throw error;
  }
}

async function loadAgentWallpaperResponse({workspaceId,userId,signal,onStage,sbImpl,loadStateImpl}){
  onStage('state:load');
  const state=await loadStateImpl(workspaceId,{authorizedUserId:userId,signal,onStage,sbImpl,readConsistentSnapshot:true});
  return {ok:true,...state,overlayUrl:'http://127.0.0.1:43120/overlay/wallpaper',overlayAvailable:true,localAgentOverlay:true,retentionDays:7,maxVisibleTiles:216,layoutSaveProtocol:AGENT_WALLPAPER_LAYOUT_PROTOCOL,settingsProtocol:2};
}
