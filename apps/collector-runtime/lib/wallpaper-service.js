import {hydrateSignatureAssetPreviews} from './signature-balloon-assets.js';
import {normalizeSoopWallpaperImageUrl,soopDefaultWallpaperImageUrl} from './soop-wallpaper-assets.js';
import {sb} from './supabase-rest.js';
import {groupWallpaperTiles,layoutWallpaperGroups,WALLPAPER_MAX_VISIBLE_TILES} from './wallpaper-layout.js';

export const WALLPAPER_OVERLAY_CLIENT_VERSION='20260903-wallpaper-v14-layer-order';

export function wallpaperOverlayUrl(token){
  return `/overlay/soop-wallpaper?v=${encodeURIComponent(WALLPAPER_OVERLAY_CLIENT_VERSION)}#token=${encodeURIComponent(token)}`;
}

function first(value){return Array.isArray(value)?value[0]||null:null}

function signalOptions(options,signal){
  if(!signal)return options;
  if(!options?.signal)return {...options,signal};
  return {...options,signal:AbortSignal.any([options.signal,signal])};
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

function optionalRows(error,signal){
  if(signal?.aborted)throw signal.reason||error;
  return [];
}

function normalizeMergeRanges(value){
  if(!Array.isArray(value))return [];
  return value.map(item=>({min:Number(item?.min),max:Number(item?.max)}))
    .filter(item=>Number.isSafeInteger(item.min)&&Number.isSafeInteger(item.max)&&item.min>=1&&item.max>=item.min&&item.max<=1_000_000)
    .sort((a,b)=>a.min-b.min||a.max-b.max).slice(0,20);
}

function normalizeSizeRanges(value){
  if(!Array.isArray(value))return [];
  const ranges=value.map(item=>({min:Number(item?.min),max:Number(item?.max),width:Number(item?.width)}))
    .filter(item=>Number.isSafeInteger(item.min)&&Number.isSafeInteger(item.max)&&Number.isSafeInteger(item.width)&&item.min>=1&&item.max>=item.min&&item.max<=1_000_000&&item.width>=80&&item.width<=480)
    .sort((a,b)=>a.min-b.min||a.max-b.max).slice(0,20);
  return ranges.filter((item,index)=>index===0||item.min>ranges[index-1].max);
}

function mergeRangeForAmount(amount,ranges){
  return ranges.find(range=>amount>=range.min&&amount<=range.max)||null;
}

function wallpaperGroupKey(row,ranges){
  const amount=Number(row.amount)||0;
  if(row.display_kind==='challenge_success')return {key:`wallpaper-challenge-success-${amount}`,mergeRange:null};
  if(row.display_kind==='subscription')return {key:`wallpaper-subscription-${amount}`,mergeRange:null};
  const mergeRange=mergeRangeForAmount(amount,ranges);
  return {key:mergeRange?`wallpaper-merge-${mergeRange.min}-${mergeRange.max}`:`wallpaper-amount-${amount}`,mergeRange};
}

function publicAssetUrl(workspaceId,row,environment){
  const source=String(row.asset_source||'');
  const asset=row.asset&&typeof row.asset==='object'&&!Array.isArray(row.asset)?row.asset:{};
  if(source==='soop'||source==='soop_default')return normalizeSoopWallpaperImageUrl(asset.url);
  return null;
}

function wallpaperAssetKey(source,asset,imageUrl){
  const value=asset&&typeof asset==='object'&&!Array.isArray(asset)?asset:{};
  const identity=String(value.storagePath||value.url||imageUrl||'').trim();
  return identity?`${String(source||'unknown')}:${identity}`:null;
}

function isFreshLiveGateway(row,now=Date.now()){
  const heartbeat=Date.parse(row?.heartbeat_at||'');
  return row?.state==='connected'&&Number.isFinite(heartbeat)&&now-heartbeat>=-5_000&&now-heartbeat<=45_000;
}

export function canUseSoopEventImage(row,currentSessionId){
  return Boolean(row?.session_id&&currentSessionId&&String(row.session_id)===String(currentSessionId));
}

export async function loadWallpaperState(workspaceId,{sbImpl=sb,environment=process.env,authorizedUserId=null,limit=WALLPAPER_MAX_VISIBLE_TILES,hydrateSignatureAssetPreviewsImpl=hydrateSignatureAssetPreviews,now=Date.now(),signal=null,onStage=()=>{},readConsistentSnapshot=false}={}){
  const callSb=(table,path='',options={})=>sbImpl(table,path,signalOptions(options,signal));
  signal?.throwIfAborted();
  onStage('state:metadata');
  const snapshot=readConsistentSnapshot?await callSb('rpc/read_wallpaper_editor_snapshot_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:authorizedUserId,p_limit:Math.max(1,Math.min(216,Math.trunc(Number(limit)||216)))}}):null;
  if(readConsistentSnapshot&&(!snapshot||!['sessions','overlays','selections','gateway','settings','tiles'].every(key=>Array.isArray(snapshot[key]))))throw new Error('풍벽지 상태를 확인하지 못했습니다. 다시 불러와주세요.');
  const [sessionRows,overlayRows,selectionRows,gatewayRows,userSettingRows]=snapshot?[snapshot.sessions,snapshot.overlays,snapshot.selections,snapshot.gateway,snapshot.settings]:await Promise.all([
    callSb('byeollog_wallpaper_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,label,state,canvas_width,canvas_height,revision,tile_count,started_at,closed_at,updated_at&order=started_at.desc&limit=50`),
    callSb('byeollog_wallpaper_overlay_states',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=revision,visible_group_keys,merge_ranges,size_ranges,active_settings_user_id,updated_at&limit=1`),
    callSb('byeollog_wallpaper_overlay_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=session_id,position,selected_at&order=position.asc,selected_at.asc&limit=20`),
    callSb('byeollog_soop_gateway_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state,chat_number,heartbeat_at,connected_at,last_event_at&limit=1`).catch(error=>optionalRows(error,signal)),
    authorizedUserId?callSb('byeollog_wallpaper_user_settings',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(authorizedUserId)}&select=merge_ranges,size_ranges,updated_at&limit=1`):Promise.resolve([])
  ]);
  const allSessionRows=Array.isArray(sessionRows)?sessionRows:[];
  const newestSessionId=allSessionRows[0]?.id||null;
  const allSessions=allSessionRows;
  const eligibleIds=new Set(allSessions.map(row=>String(row.id)));
  const gateway=first(gatewayRows),live=isFreshLiveGateway(gateway,now);
  const activeSession=allSessions.find(row=>row.state==='active')||null;
  const currentSessionId=live&&activeSession?.id?activeSession.id:newestSessionId;
  const selectedIds=(Array.isArray(selectionRows)?selectionRows:[]).map(row=>String(row.session_id||'')).filter(id=>eligibleIds.has(id));
  const selectedSessionPriority=new Map(selectedIds.map((id,index)=>[id,index]));
  const selectedSet=new Set(selectedIds);
  const sessions=allSessions.map(row=>({
    id:row.id,label:String(row.label||'방송 회차'),state:row.state,isLive:live&&row.id===activeSession?.id,
    tileCount:Number(row.tile_count)||0,startedAt:row.started_at,closedAt:row.closed_at,
    selected:selectedSet.has(row.id)
  }));
  const selectedSessions=selectedIds.map(id=>allSessions.find(row=>row.id===id)).filter(Boolean);
  const overlay=first(overlayRows);
  const revision=Number(overlay?.revision)||0;
  const activeMergeRules=normalizeMergeRanges(overlay?.merge_ranges);
  const savedMergeRules=normalizeMergeRanges(first(userSettingRows)?.merge_ranges);
  const activeSizeRules=normalizeSizeRanges(overlay?.size_ranges);
  const savedSizeRules=normalizeSizeRanges(first(userSettingRows)?.size_ranges);
  const visibility={visibleKeys:(Array.isArray(overlay?.visible_group_keys)?overlay.visible_group_keys:[]).map(String).filter(key=>/^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$/.test(key)).slice(0,500)};
  const liveState={isLive:live,state:String(gateway?.state||'not_started'),heartbeatAt:gateway?.heartbeat_at||null,chatNumber:gateway?.chat_number||null};
  const merge={rules:activeMergeRules,savedRules:authorizedUserId?savedMergeRules:activeMergeRules,activeForCurrentUser:Boolean(authorizedUserId&&overlay?.active_settings_user_id===authorizedUserId)};
  const size={rules:activeSizeRules,savedRules:authorizedUserId?savedSizeRules:activeSizeRules,activeForCurrentUser:Boolean(authorizedUserId&&overlay?.active_settings_user_id===authorizedUserId)};
  if(!selectedSessions.length)return {session:null,displayKey:'empty',revision,totalTiles:0,visibleTiles:0,hiddenTiles:0,visibility,catalog:[],merge,size,live:liveState,hasManualLayout:false,groups:[],tiles:[],sessions,selectedSessionIds:[]};
  const safeLimit=Math.max(1,Math.min(WALLPAPER_MAX_VISIBLE_TILES,Math.trunc(Number(limit)||WALLPAPER_MAX_VISIBLE_TILES)));
  const sessionFilter=selectedIds.map(id=>encodeURIComponent(id)).join(',');
  onStage('state:tiles');
  const rows=snapshot?snapshot.tiles:await callSb('byeollog_wallpaper_tiles',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&session_id=in.(${sessionFilter})&select=id,sequence_no,session_id,actor_name,amount,display_kind,asset_source,asset,received_at,layout_x,layout_y,layout_width,layout_height,layout_columns,layout_rows,layout_next_side,layout_layer&order=received_at.desc,sequence_no.desc&limit=${safeLimit}`);
  const ordered=(Array.isArray(rows)?rows:[]).reverse();
  const amounts=[...new Set(ordered.map(row=>Number(row.amount)).filter(value=>Number.isSafeInteger(value)&&value>0))];
  const needsWorkspaceDefaults=ordered.some(row=>row.display_kind!=='challenge_success'&&row.display_kind!=='subscription'&&(row.asset_source!=='soop'||!canUseSoopEventImage(row,currentSessionId)));
  onStage('state:image-references');
  const [signatureRows,defaultRows]=await Promise.all([
    amounts.length?callSb('byeollog_signature_balloons',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&balloon_count=in.(${amounts.join(',')})&select=balloon_count,wallpaper_image,updated_at`).catch(error=>optionalRows(error,signal)):Promise.resolve([]),
    needsWorkspaceDefaults?callSb('byeollog_default_donation_images',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=min_amount,max_amount,pc_image,updated_at&order=min_amount.asc&limit=50`).catch(error=>optionalRows(error,signal)):Promise.resolve([])
  ]);
  const currentSignatures=(Array.isArray(signatureRows)?signatureRows:[]).filter(row=>row.wallpaper_image?.storagePath);
  let hydrated=[];
  if(currentSignatures.length){
    try{
      onStage('state:signature-urls');
      hydrated=await abortable(hydrateSignatureAssetPreviewsImpl(workspaceId,currentSignatures.map(row=>({kind:'wallpaper',reference:row.wallpaper_image}))),signal);
    }catch(error){
      if(signal?.aborted)throw signal.reason||error;
      console.error('[wallpaper] private preview unavailable',{name:error?.name||'Error',status:error?.status||null});
    }
  }
  const signatureImages=new Map(currentSignatures.map((row,index)=>[Number(row.balloon_count),{
    imageUrl:hydrated[index]?.previewUrl||null,
    imageKey:wallpaperAssetKey('signature',row.wallpaper_image,hydrated[index]?.previewUrl)
  }]));
  const currentDefaults=(Array.isArray(defaultRows)?defaultRows:[]).filter(row=>row.pc_image?.storagePath);
  let hydratedDefaults=[];
  if(currentDefaults.length){
    try{
      onStage('state:default-urls');
      hydratedDefaults=await abortable(hydrateSignatureAssetPreviewsImpl(workspaceId,currentDefaults.map(row=>({kind:'default-pc',reference:row.pc_image}))),signal);
    }catch(error){
      if(signal?.aborted)throw signal.reason||error;
      console.error('[wallpaper] private default preview unavailable',{name:error?.name||'Error',status:error?.status||null});
    }
  }
  const defaultImages=currentDefaults.map((row,index)=>({
    min:Number(row.min_amount)||1,max:row.max_amount===null||row.max_amount===undefined?Number.MAX_SAFE_INTEGER:Number(row.max_amount),
    imageUrl:hydratedDefaults[index]?.previewUrl||null,
    imageKey:wallpaperAssetKey('workspace_default',row.pc_image,hydratedDefaults[index]?.previewUrl)
  })).filter(row=>row.imageUrl&&Number.isSafeInteger(row.min)&&Number.isSafeInteger(row.max)&&row.max>=row.min);
  const latestImages=new Map();
  for(const row of ordered){
    if(row.asset_source!=='soop'||row.display_kind==='challenge_success'||row.display_kind==='subscription'||!canUseSoopEventImage(row,currentSessionId))continue;
    const imageUrl=publicAssetUrl(workspaceId,row,environment);
    if(imageUrl)latestImages.set(Number(row.amount),{imageUrl,imageKey:wallpaperAssetKey(row.asset_source,row.asset,imageUrl),source:row.asset_source});
  }
  const display=ordered.map(row=>{
    const amount=Number(row.amount)||0,displayKind=row.display_kind==='challenge_success'?'challenge_success':row.display_kind==='subscription'?'subscription':'donation',signatureImage=signatureImages.get(amount),latest=latestImages.get(amount),workspaceDefault=defaultImages.find(item=>amount>=item.min&&amount<=item.max);
    const mayUseSoopEventImage=canUseSoopEventImage(row,currentSessionId);
    const officialEventUrl=mayUseSoopEventImage&&(displayKind==='challenge_success'||displayKind==='subscription')?publicAssetUrl(workspaceId,row,environment):null;
    const selected=displayKind==='subscription'
      ?{imageUrl:officialEventUrl,imageKey:wallpaperAssetKey('soop',row.asset,officialEventUrl),source:officialEventUrl?'soop':'none'}
      :displayKind==='challenge_success'
      ?{imageUrl:officialEventUrl,imageKey:wallpaperAssetKey('soop',row.asset,officialEventUrl),source:officialEventUrl?'soop':'none'}
      :signatureImage?.imageUrl?{...signatureImage,source:'signature'}
      :mayUseSoopEventImage&&latest?.imageUrl?latest:null;
    const fallbackSelected=selected||(displayKind==='donation'&&workspaceDefault?.imageUrl?{...workspaceDefault,source:'workspace_default'}:null);
    // SOOP imageUrl values (including the official ceremony fallback) are only
    // valid for the current broadcast round. Historical rounds remain usable,
    // but render as a text-only card when the workspace has no owned image.
    const officialFallbackUrl=mayUseSoopEventImage&&displayKind==='donation'?soopDefaultWallpaperImageUrl(row.amount):null;
    const imageUrl=fallbackSelected?.imageUrl||officialFallbackUrl||null;
    const source=fallbackSelected?.source||(officialFallbackUrl?'soop_default':'none');
    const imageKey=fallbackSelected?.imageKey||(officialFallbackUrl?wallpaperAssetKey('soop_default',{url:officialFallbackUrl},officialFallbackUrl):null);
    const grouping=wallpaperGroupKey(row,activeMergeRules);
    const coordinates=[row.layout_x,row.layout_y,row.layout_width,row.layout_height].map(Number);
    const hasCapacity=row.layout_columns!==null&&row.layout_columns!==undefined&&row.layout_rows!==null&&row.layout_rows!==undefined;
    const capacity=[row.layout_columns,row.layout_rows].map(Number);
    const layout=coordinates.every(Number.isSafeInteger)
      ?{x:coordinates[0],y:coordinates[1],width:coordinates[2],height:coordinates[3],columns:hasCapacity&&capacity.every(Number.isSafeInteger)?capacity[0]:null,rows:hasCapacity&&capacity.every(Number.isSafeInteger)?capacity[1]:null,nextSide:row.layout_next_side==='left'?'left':'right',layer:Number.isSafeInteger(Number(row.layout_layer))?Number(row.layout_layer):null}
      :null;
    return {id:row.id,groupKey:grouping.key,mergeRange:grouping.mergeRange,visibilityKey:displayKind+':'+amount,sessionId:row.session_id,layoutPriority:selectedSessionPriority.get(String(row.session_id))??Number.MAX_SAFE_INTEGER,sequenceNo:Number(row.sequence_no)||0,actorName:String(row.actor_name||'익명'),amount,displayKind,source,imageUrl,imageKey,receivedAt:row.received_at,layout};
  });
  const visibleKeys=new Set(visibility.visibleKeys),catalogMap=new Map();
  for(const tile of display){const item=catalogMap.get(tile.visibilityKey);if(item)item.count++;else catalogMap.set(tile.visibilityKey,{key:tile.visibilityKey,amount:tile.amount,displayKind:tile.displayKind,count:1,visible:visibleKeys.has(tile.visibilityKey)})}
  const catalog=[...catalogMap.values()].sort((a,b)=>a.amount-b.amount||a.displayKind.localeCompare(b.displayKind));
  const visibleDisplay=display.filter(tile=>visibleKeys.has(tile.visibilityKey));
  const newest=selectedSessions.reduce((latest,row)=>!latest||Date.parse(row.started_at)>Date.parse(latest.started_at)?row:latest,null);
  const canvasWidth=Number(newest?.canvas_width)||1920,canvasHeight=Number(newest?.canvas_height)||1080;
  const groups=layoutWallpaperGroups(groupWallpaperTiles(visibleDisplay),{canvasWidth,canvasHeight,sizeRanges:activeSizeRules});
  const tiles=groups.flatMap(group=>group.cards.map(card=>({...card,x:group.x+card.x,y:group.y+card.y,groupId:group.id,manualLayout:group.manualLayout})));
  const displayKey=selectedIds.join(':');
  signal?.throwIfAborted();
  return {
    session:{id:newest?.id,state:newest?.state,canvasWidth,canvasHeight,
      startedAt:selectedSessions.reduce((value,row)=>!value||Date.parse(row.started_at)<Date.parse(value)?row.started_at:value,null),isLive:live&&selectedSessions.some(row=>row.id===activeSession?.id),
      updatedAt:overlay?.updated_at||newest?.updated_at,selectedCount:selectedSessions.length},
    displayKey,revision,
    totalTiles:selectedSessions.reduce((sum,row)=>sum+(Number(row.tile_count)||0),0),
    visibleTiles:visibleDisplay.length,hiddenTiles:display.length-visibleDisplay.length,visibility,catalog,merge,size,live:liveState,
    hasManualLayout:groups.some(group=>group.manualLayout),
    groups,tiles,sessions,selectedSessionIds:selectedIds
  };
}
