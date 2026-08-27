(()=>{
  'use strict';
  const palettes={
    roulette_navy_gold_v1:['#0b1f44','#dca92f'],
    roulette_royal_purple_rose_gold_v1:['#4a237a','#d99587'],
    roulette_emerald_champagne_v1:['#08705f','#e6c989'],
    roulette_burgundy_pale_gold_v1:['#721f35','#ddc47c'],
    roulette_graphite_cyan_v1:['#242a33','#1dc7d6'],
    roulette_pastel_powder_blue_peach_v1:['#a9cde7','#f2b391'],
    roulette_pastel_lavender_butter_v1:['#aa9bc5','#eadb8d']
  };
  const state={assets:[],devices:[],selectedAssetKey:'',items:[],profile:null};
  const byId=id=>document.getElementById(id);
  const text=(element,value)=>{element.textContent=String(value??'')};
  const field=(labelText,input)=>{
    const wrapper=document.createElement('div');wrapper.className='field';
    const label=document.createElement('label');label.textContent=labelText;
    wrapper.append(label,input);return wrapper;
  };
  const input=(type,value)=>{const element=document.createElement('input');element.type=type;element.value=value??'';return element};
  const percentText=ppm=>(Number(ppm||0)/10000).toFixed(4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g,'').replace(/\.$/,'');
  const ppmFromPercent=value=>{
    const match=String(value??'').trim().match(/^(\d{1,3})(?:\.(\d{1,4}))?$/);
    if(!match)throw new Error('확률은 소수점 넷째 자리까지 입력하세요.');
    const ppm=Number(match[1])*10000+Number(String(match[2]||'').padEnd(4,'0'));
    if(ppm<1||ppm>=1000000)throw new Error('각 상품 확률은 0%보다 크고 100%보다 작아야 합니다.');
    return ppm;
  };
  function defaultItems(){return [
    {resultText:'상품 1',probabilityPpm:500000,directUpbo:false,upboEventName:'',ttsText:'상품 1, 당첨!'},
    {resultText:'상품 2',probabilityPpm:500000,directUpbo:false,upboEventName:'',ttsText:'상품 2, 당첨!'}
  ]}
  function setStatus(message,tone=''){
    const target=byId('pageStatus');target.className='status '+tone;text(target,message);
  }
  function renderAssets(){
    const list=byId('assetList');list.replaceChildren();
    for(const asset of state.assets){
      const button=document.createElement('button');button.type='button';button.className='asset'+(state.selectedAssetKey===asset.key?' selected':'');
      const swatch=document.createElement('div');swatch.className='swatch';
      const colors=asset.swatch||palettes[asset.key]||['#20324c','#28af86'];
      swatch.style.background=`conic-gradient(from 20deg,${colors[0]} 0 25%,${colors[1]} 25% 50%,${colors[0]} 50% 75%,${colors[1]} 75%)`;
      const strong=document.createElement('strong');text(strong,asset.displayName);
      const small=document.createElement('small');text(small,asset.deliveryStatus==='published'?'WebP 배포 완료':'최종 WebP · 배포 대기');
      button.append(swatch,strong,small);button.addEventListener('click',()=>{state.selectedAssetKey=asset.key;renderAssets()});list.append(button);
    }
  }
  function renderDevices(){
    const select=byId('agentDevice');select.replaceChildren();
    if(!state.devices.length){
      const option=document.createElement('option');option.value='';text(option,'연결된 에이전트가 없습니다');select.append(option);select.disabled=true;return;
    }
    select.disabled=false;
    for(const device of state.devices){const option=document.createElement('option');option.value=device.deviceId;text(option,device.displayName||device.deviceId);select.append(option)}
    if(state.profile?.agentDeviceId)select.value=state.profile.agentDeviceId;
  }
  function renderProbability(){
    const total=state.items.reduce((sum,item)=>sum+Number(item.probabilityPpm||0),0);
    const target=byId('probabilityStatus');target.className='status '+(total===1000000?'ok':'error');
    text(target,`현재 합계 ${(total/10000).toFixed(4).replace(/\.0+$/,'')}% · ${total===1000000?'저장 가능':'정확히 100%로 맞춰주세요.'}`);
  }
  function updateItem(index,patch){state.items[index]={...state.items[index],...patch};renderProbability()}
  function renderItems(){
    const list=byId('itemList');list.replaceChildren();
    state.items.forEach((item,index)=>{
      const row=document.createElement('div');row.className='item';
      const name=input('text',item.resultText);name.maxLength=200;name.placeholder='당첨 상품명';
      name.addEventListener('input',()=>{
        const previous=state.items[index].resultText;
        const automatic=state.items[index].ttsText===`${previous}, 당첨!`;
        updateItem(index,{resultText:name.value,ttsText:automatic?`${name.value}, 당첨!`:state.items[index].ttsText});
      });
      const probability=input('text',percentText(item.probabilityPpm));probability.inputMode='decimal';
      probability.addEventListener('change',()=>{try{updateItem(index,{probabilityPpm:ppmFromPercent(probability.value)})}catch(error){setStatus(error.message,'error');probability.value=percentText(state.items[index].probabilityPpm)}});
      const upbo=document.createElement('input');upbo.type='checkbox';upbo.checked=item.directUpbo;
      const upboWrap=document.createElement('label');upboWrap.className='inline';upboWrap.append(upbo,document.createTextNode(' 업보 직행'));
      upbo.addEventListener('change',()=>{state.items[index]={...state.items[index],directUpbo:upbo.checked};renderItems()});
      const detail=input('text',item.directUpbo?(item.upboEventName||byId('rouletteName').value):(item.ttsText||`${item.resultText}, 당첨!`));detail.maxLength=item.directUpbo?120:160;
      detail.addEventListener('input',()=>updateItem(index,item.directUpbo?{upboEventName:detail.value}:{ttsText:detail.value}));
      const remove=document.createElement('button');remove.type='button';remove.textContent='삭제';remove.disabled=state.items.length<=2;
      remove.addEventListener('click',()=>{if(state.items.length<=2)return;state.items.splice(index,1);renderItems()});
      const detailField=field(item.directUpbo?'업보 룰렛명':'미리 생성할 TTS 문구',detail);detailField.classList.add('tts-field');
      row.append(field('상품명',name),field('확률 (%)',probability),field('처리 방식',upboWrap),detailField,remove);
      if(item.directUpbo){const note=document.createElement('div');note.className='upbo-note';note.textContent='당첨 시 다른 절차를 모두 생략하고 업보로 바로 보냅니다. 상품명의 & 분리는 그대로 유지됩니다.';row.append(note)}
      list.append(row);
    });renderProbability();
  }
  function applyProfile(profile){
    state.profile=profile||null;
    if(!profile){state.items=defaultItems();return}
    byId('rouletteName').value=profile.name||'별록 룰렛';
    byId('balloonsPerSpin').value=String(profile.balloonsPerSpin||30);
    byId('allowMultipleSpins').checked=profile.allowMultipleSpins===true;
    byId('soundVolume').value=String(profile.soundVolumePercent??80);
    byId('ttsVolume').value=String(profile.ttsVolumePercent??80);
    byId('followupChatTtsWindow').value=String(profile.followupChatTtsWindowSeconds??10);
    state.selectedAssetKey=profile.overlayAssetKey||state.assets[0]?.key||'';
    state.items=Array.isArray(profile.items)&&profile.items.length?profile.items.map(item=>({...item})):defaultItems();
    const cache=profile.cache||{};text(byId('cacheTotal'),cache.total||0);text(byId('cacheReady'),cache.ready||0);text(byId('cachePending'),cache.pending||0);
  }
  async function request(url,options){
    const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options?.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message||`요청 실패 (${response.status})`);return data;
  }
  async function load(){
    setStatus('룰렛 설정을 불러오는 중입니다.');
    try{
      const data=await request('/api/native-roulette?operation=settings');
      state.assets=Array.isArray(data.assets)?data.assets:[];state.devices=Array.isArray(data.agentDevices)?data.agentDevices:[];
      if(!state.selectedAssetKey)state.selectedAssetKey=state.assets[0]?.key||'';applyProfile(data.profile);renderDevices();renderAssets();renderItems();setStatus('초안 설정을 불러왔습니다.','ok');
    }catch(error){
      try{const fallback=await request('/api/native-roulette?operation=assets');state.assets=fallback.assets||[];state.selectedAssetKey=state.assets[0]?.key||''}catch{}
      state.items=defaultItems();renderDevices();renderAssets();renderItems();setStatus(error.message,'error');
    }
  }
  async function save(){
    try{
      if(!byId('agentDevice').value)throw new Error('캐시할 스트리머 PC를 선택하세요.');
      if(!state.selectedAssetKey)throw new Error('오버레이 WebP를 선택하세요.');
      const total=state.items.reduce((sum,item)=>sum+Number(item.probabilityPpm||0),0);if(total!==1000000)throw new Error('전체 상품 확률의 합을 정확히 100%로 맞춰주세요.');
      const payload={
        name:byId('rouletteName').value,balloonsPerSpin:Number(byId('balloonsPerSpin').value),
        allowMultipleSpins:byId('allowMultipleSpins').checked,agentDeviceId:byId('agentDevice').value,
        overlayAssetKey:state.selectedAssetKey,soundKey:'roulette_spin_v1',
        soundVolumePercent:Number(byId('soundVolume').value),ttsVolumePercent:Number(byId('ttsVolume').value),
        followupChatTtsWindowSeconds:Number(byId('followupChatTtsWindow').value),
        items:state.items.map(item=>({
          id:item.id||null,resultText:item.resultText,probabilityPpm:Number(item.probabilityPpm),directUpbo:item.directUpbo===true,
          upboEventName:item.directUpbo?(item.upboEventName||byId('rouletteName').value):null,
          ttsText:item.directUpbo?null:(item.ttsText||`${item.resultText}, 당첨!`)
        }))
      };
      const button=byId('saveDraft');button.disabled=true;setStatus('새 버전을 저장하고 TTS 캐시 목록을 만드는 중입니다.');
      const result=await request('/api/native-roulette?operation=settings',{method:'POST',body:JSON.stringify(payload)});
      setStatus(`버전 ${result.versionNumber||''} 초안을 저장했습니다. 에이전트 캐시는 활성화 전에 반드시 확인됩니다.`,'ok');
      await load();
    }catch(error){setStatus(error.message,'error')}finally{byId('saveDraft').disabled=false}
  }
  byId('addItem').addEventListener('click',()=>{
    if(state.items.length>=100)return setStatus('상품은 최대 100개까지 추가할 수 있습니다.','error');
    state.items.push({resultText:`상품 ${state.items.length+1}`,probabilityPpm:1,directUpbo:false,upboEventName:'',ttsText:`상품 ${state.items.length+1}, 당첨!`});renderItems();
  });
  byId('saveDraft').addEventListener('click',save);
  for(const id of ['soundVolume','ttsVolume'])byId(id).addEventListener('input',()=>text(byId(id+'Text'),byId(id).value+'%'));
  load();
})();
