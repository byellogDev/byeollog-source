import {normalizeSoopCeremonyImageUrl} from './native-roulette.js';
import {rouletteAssetPublicUrl} from './roulette-custom-assets.js';
import {hydrateSignatureAssetPreviews} from './signature-balloon-assets.js';
import {soopDefaultCeremonyImageUrl} from './soop-roulette-service.js';
import {sb} from './supabase-rest.js';
import {groupWallpaperTiles,layoutWallpaperGroups,WALLPAPER_MAX_VISIBLE_TILES} from './wallpaper-layout.js';

export const WALLPAPER_OVERLAY_CLIENT_VERSION='20260901-wallpaper-v13-persistent-size-no-shadow';

export function wallpaperOverlayUrl(token){
  return `/overlay/soop-wallpaper?v=${encodeURIComponent(WALLPAPER_OVERLAY_CLIENT_VERSION)}#token=${encodeURIComponent(token)}`;
}

function first(value){return Array.isArray(value)?value[0]||null:null}

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
  if(source==='roulette'&&String(asset.storagePath||'').startsWith(`workspaces/${workspaceId}/`)){
    try{return rouletteAssetPublicUrl(asset.storagePath,environment)}catch{return null}
  }
  if(source==='soop'||source==='soop_default')return normalizeSoopCeremonyImageUrl(asset.url);
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

function currentRouletteAssets(snapshot){
  const result=new Map();
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return result;
  const single=Number(snapshot.balloonsPerSpin),singleAsset=snapshot.customSingleImage;
  if(Number.isSafeInteger(single)&&single>0&&singleAsset&&typeof singleAsset==='object')result.set(single,{source:'roulette',asset:singleAsset});
  const series=Number(snapshot.seriesBalloons),seriesAsset=snapshot.customSeriesImage||singleAsset;
  if(snapshot.seriesEnabled===true&&Number.isSafeInteger(series)&&series>0&&seriesAsset&&typeof seriesAsset==='object')result.set(series,{source:'roulette',asset:seriesAsset});
  return result;
}

export async function loadWallpaperState(workspaceId,{sbImpl=sb,environment=process.env,authorizedUserId=null,limit=WALLPAPER_MAX_VISIBLE_TILES,hydrateSignatureAssetPreviewsImpl=hydrateSignatureAssetPreviews}={}){
  const [sessionRows,overlayRows,selectionRows,gatewayRows,serviceRows,userSettingRows]=await Promise.all([
    sbImpl('byeollog_wallpaper_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,label,state,canvas_width,canvas_height,revision,tile_count,started_at,closed_at,updated_at&order=started_at.desc&limit=50`),
    sbImpl('byeollog_wallpaper_overlay_states',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=revision,visible_group_keys,merge_ranges,size_ranges,active_settings_user_id,updated_at&limit=1`),
    sbImpl('byeollog_wallpaper_overlay_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=session_id,position,selected_at&order=position.asc,selected_at.asc&limit=20`),
    sbImpl('byeollog_soop_gateway_sessions',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state,chat_number,heartbeat_at,connected_at,last_event_at&limit=1`).catch(()=>[]),
    sbImpl('byeollog_native_roulette_services',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&state=eq.active&select=activation_snapshot&limit=1`).catch(()=>[]),
    authorizedUserId?sbImpl('byeollog_wallpaper_user_settings',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(authorizedUserId)}&select=merge_ranges,size_ranges,updated_at&limit=1`).catch(()=>[]):Promise.resolve([])
  ]);
  const allSessions=Array.isArray(sessionRows)?sessionRows:[];
  const gateway=first(gatewayRows),live=isFreshLiveGateway(gateway);
  const activeSession=allSessions.find(row=>row.state==='active')||null;
  const selectedIds=(Array.isArray(selectionRows)?selectionRows:[]).map(row=>String(row.session_id||'')).filter(Boolean);
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
  const rows=await sbImpl('byeollog_wallpaper_tiles',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&session_id=in.(${sessionFilter})&select=id,sequence_no,session_id,actor_name,amount,display_kind,asset_source,asset,received_at,layout_x,layout_y,layout_width,layout_height,layout_columns,layout_rows,layout_next_side&order=received_at.desc,sequence_no.desc&limit=${safeLimit}`);
  const ordered=(Array.isArray(rows)?rows:[]).reverse();
  const amounts=[...new Set(ordered.map(row=>Number(row.amount)).filter(value=>Number.isSafeInteger(value)&&value>0))];
  const signatureRows=amounts.length?await sbImpl('byeollog_signature_balloons',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&balloon_count=in.(${amounts.join(',')})&select=balloon_count,wallpaper_image,updated_at`).catch(()=>[]):[];
  const currentSignatures=(Array.isArray(signatureRows)?signatureRows:[]).filter(row=>row.wallpaper_image?.storagePath);
  let hydrated=[];
  if(currentSignatures.length){
    try{
      hydrated=await hydrateSignatureAssetPreviewsImpl(workspaceId,currentSignatures.map(row=>({kind:'wallpaper',reference:row.wallpaper_image})));
    }catch(error){
      console.error('[wallpaper] private preview unavailable',{name:error?.name||'Error',status:error?.status||null});
    }
  }
  const signatureImages=new Map(currentSignatures.map((row,index)=>[Number(row.balloon_count),{
    imageUrl:hydrated[index]?.previewUrl||null,
    imageKey:wallpaperAssetKey('signature',row.wallpaper_image,hydrated[index]?.previewUrl)
  }]));
  const rouletteAssets=currentRouletteAssets(first(serviceRows)?.activation_snapshot),rouletteImages=new Map();
  for(const [amount,value] of rouletteAssets){
    const imageUrl=publicAssetUrl(workspaceId,{asset_source:value.source,asset:value.asset},environment);
    if(imageUrl)rouletteImages.set(amount,{imageUrl,imageKey:wallpaperAssetKey('roulette',value.asset,imageUrl)});
  }
  const latestImages=new Map();
  for(const row of ordered){
    if(row.asset_source!=='soop'||row.display_kind==='challenge_success'||row.display_kind==='subscription')continue;
    const imageUrl=publicAssetUrl(workspaceId,row,environment);
    if(imageUrl)latestImages.set(Number(row.amount),{imageUrl,imageKey:wallpaperAssetKey(row.asset_source,row.asset,imageUrl),source:row.asset_source});
  }
  const display=ordered.map(row=>{
    const amount=Number(row.amount)||0,displayKind=row.display_kind==='challenge_success'?'challenge_success':row.display_kind==='subscription'?'subscription':'donation',signatureImage=signatureImages.get(amount),rouletteImage=rouletteImages.get(amount),latest=latestImages.get(amount);
    const officialEventUrl=(displayKind==='challenge_success'||displayKind==='subscription')?publicAssetUrl(workspaceId,row,environment):null;
    const selected=displayKind==='subscription'
      ?{imageUrl:officialEventUrl,imageKey:wallpaperAssetKey('soop',row.asset,officialEventUrl),source:officialEventUrl?'soop':'none'}
      :displayKind==='challenge_success'
      ?{imageUrl:officialEventUrl,imageKey:wallpaperAssetKey('soop',row.asset,officialEventUrl),source:'soop'}
      :signatureImage?.imageUrl?{...signatureImage,source:'signature'}
      :rouletteImage?.imageUrl?{...rouletteImage,source:'roulette'}
      :latest?.imageUrl?latest:null;
    const imageUrl=selected?.imageUrl||(displayKind==='subscription'?null:soopDefaultCeremonyImageUrl(row.amount));
    const source=selected?.source||(displayKind==='subscription'?'none':'soop_default');
    const imageKey=selected?.imageKey||(displayKind==='subscription'?null:wallpaperAssetKey('soop_default',{url:imageUrl},imageUrl));
    const grouping=wallpaperGroupKey(row,activeMergeRules);
    const coordinates=[row.layout_x,row.layout_y,row.layout_width,row.layout_height].map(Number);
    const hasCapacity=row.layout_columns!==null&&row.layout_columns!==undefined&&row.layout_rows!==null&&row.layout_rows!==undefined;
    const capacity=[row.layout_columns,row.layout_rows].map(Number);
    const layout=coordinates.every(Number.isSafeInteger)
      ?{x:coordinates[0],y:coordinates[1],width:coordinates[2],height:coordinates[3],columns:hasCapacity&&capacity.every(Number.isSafeInteger)?capacity[0]:null,rows:hasCapacity&&capacity.every(Number.isSafeInteger)?capacity[1]:null,nextSide:row.layout_next_side==='left'?'left':'right'}
      :null;
    return {id:row.id,groupKey:grouping.key,mergeRange:grouping.mergeRange,visibilityKey:displayKind+':'+amount,sessionId:row.session_id,sequenceNo:Number(row.sequence_no)||0,actorName:String(row.actor_name||'익명'),amount,displayKind,source,imageUrl,imageKey,receivedAt:row.received_at,layout};
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
