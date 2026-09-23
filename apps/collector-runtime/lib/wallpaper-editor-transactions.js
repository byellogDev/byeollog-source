// The surrounding editor supplies request/state/render functions. Keep the same
// transaction boundary in the website and the generated WebView application.
function wallpaperSettingsBusy() {
  return wallpaperEditSession.busy || state.wallpaperSessionSaving || Boolean(state.wallpaperPointer);
}

function updateWallpaperSettingsBusy() {
  const busy=wallpaperSettingsBusy();
  for(const id of ['saveWallpaperMergeBtn','saveWallpaperSizeRulesBtn','resetWallpaperBtn']) {
    const button=$(id);if(button)button.disabled=busy;
  }
  const panel=$('wallpaperSettingsModal');
  if(panel)for(const input of panel.querySelectorAll('input,textarea,select,button'))input.disabled=busy;
  renderWallpaperCatalog();renderWallpaperSessions();
}

function applyWallpaperEditorSnapshot(next,preserveDraft=false) {
  if(!next||!Number.isSafeInteger(Number(next.revision))||!Array.isArray(next.groups))throw new Error('풍벽지 상태를 다시 확인해주세요.');
  if(state.wallpaper&&Number(next.revision)<Number(state.wallpaper.revision))throw new Error('최신 풍벽지 상태를 다시 확인해주세요.');
  const selected=state.wallpaperSelectedGroup;
  state.wallpaper=next;
  if(state.wallpaperEditing&&preserveDraft)rebaseWallpaperDraft(next,true);else initializeWallpaperEditor();
  if(state.wallpaperDraft?.some(group=>group.id===selected))state.wallpaperSelectedGroup=selected;
  state.wallpaperNeedsRefresh=false;
  renderWallpaper();
}

async function reloadWallpaperEditorState(preserveDraft=true) {
  const next=await request(localWallpaperEditor?'wallpaper-refresh':'wallpaper-control');
  applyWallpaperEditorSnapshot(next,preserveDraft);
  return next;
}

async function commitWallpaperSetting(action,payload,statusId,message) {
  if(wallpaperSettingsBusy())return false;
  const ticket=wallpaperEditSession.begin(action);
  state.wallpaperSettingsSaving=true;
  updateWallpaperSettingsBusy();
  try {
    if(state.wallpaperNeedsRefresh)await reloadWallpaperEditorState(true);
    await flushWallpaperEdits();
    const values=typeof payload==='function'?payload():payload;
    status(statusId,'설정을 저장하는 중입니다.');
    const baseline=action==='save-visibility'?state.wallpaper:state.wallpaperSettingsBase||state.wallpaper;
    const next=await request('wallpaper-control',{method:'POST',body:JSON.stringify({action,expectedRevision:baseline.revision,...values,responseMode:'state-or-receipt'})});
    if(next.refreshPending&&next.committed){
      state.wallpaperNeedsRefresh=true;
      try {await reloadWallpaperEditorState(false)}
      catch {status(statusId,'설정은 저장됐습니다. 화면을 불러오지 못해 새로고침이 필요합니다.','');return true}
    }else applyWallpaperEditorSnapshot(next,false);
    state.wallpaperSettingsBase=state.wallpaper;
    status(statusId,message,'ok');
    return true;
  }catch(error){
    if(error.status===409){
      // Preserve typed settings. Only the server snapshot/draft base is refreshed.
      try{await reloadWallpaperEditorState(true);state.wallpaperSettingsBase=state.wallpaper}catch{state.wallpaperNeedsRefresh=true}
    }
    status(statusId,error.message,'error');return false;
  }finally{
    state.wallpaperSettingsSaving=false;wallpaperEditSession.finish(ticket);updateWallpaperSettingsBusy();
  }
}

function prepareWallpaperSizeChange(sizeRules) {
  if(Number(state.wallpaper?.settingsProtocol)<2||!state.wallpaper?.settingsProtocol)throw new Error('풍벽지 편집기를 새로고침한 뒤 다시 저장해주세요.');
  const previous=state.wallpaperDraft;
  state.wallpaperDraft=(previous||[]).map(group=>({...group,tileIds:[...(group.tileIds||[])],cards:(group.cards||[]).map(card=>({...card}))}));
  try{
    for(const rule of sizeRules)applyWallpaperWidthRule(rule);
    return {sizeRules,layoutSaveProtocol:WALLPAPER_LAYOUT_SAVE_PROTOCOL,layoutTiles:wallpaperLayoutTiles()};
  }finally{state.wallpaperDraft=previous}
}

export const wallpaperEditorTransactionsScript=[wallpaperSettingsBusy,updateWallpaperSettingsBusy,applyWallpaperEditorSnapshot,reloadWallpaperEditorState,commitWallpaperSetting,prepareWallpaperSizeChange].map(fn=>fn.toString()).join('\n');
