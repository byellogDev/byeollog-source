/* Local-only service integration. No account, API, upload, polling or database dependency. */
(() => {
 'use strict';
 const MAX_FILE=8*1024*1024, MAX_DESIGN=24*1024*1024, MAX_IMAGES=20;
 const imagePattern=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
 const own=(o,k)=>o&&typeof o==='object'&&Object.hasOwn(o,k)?o[k]:undefined;
 const read=(o,path)=>path.split('.').reduce(own,o);
 let dirty=false, importing=false, uploadBusy=false, noticeTimer;
 function notify(message,error=false){clearTimeout(noticeTimer);$('studioStatus').textContent=message;$('studioStatus').dataset.error=String(error);noticeTimer=setTimeout(()=>$('studioStatus').textContent='',error?15000:6000)}
 document.addEventListener('input',e=>{if(!importing&&e.target.closest('.app,#settingsModal'))dirty=true});
 document.addEventListener('click',e=>{if(e.target.closest('[data-pattern-choice],[data-align],[data-text-align],[data-text-valign],[data-density],[data-tail-align],.preset,#duplicateLayer,#deleteLayer,#layerFront,#layerBack'))dirty=true});
 document.addEventListener('keydown',e=>{if(e.target.closest('.chat-text-content')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))dirty=true},true);
 document.addEventListener('pointerup',e=>{if(e.target.closest('#previewStage'))dirty=true});
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
 const controls={
  align:'layout.alignment',maxWidth:'layout.maxWidth',gap:'layout.gap',frameWidth:'canvas.width',frameHeight:'canvas.height',frameX:'canvas.x',frameY:'canvas.y',
  bgAdv:'bubble.background',textAdv:'bubble.textColor',borderAdv:'bubble.borderColor',borderWidth:'bubble.borderWidth',
  radTL:'bubble.radius.tl',radTR:'bubble.radius.tr',radBR:'bubble.radius.br',radBL:'bubble.radius.bl',padTop:'bubble.padding.top',padRight:'bubble.padding.right',padBottom:'bubble.padding.bottom',padLeft:'bubble.padding.left',
  patternPreset:'pattern.preset',patternColor:'pattern.color',patternOpacity:'pattern.opacity',patternSize:'pattern.size',
  tailEnabled:'tail.enabled',tailShape:'tail.shape',tailAlignMode:'tail.alignMode',tailEdgeOffset:'tail.edgeOffset',tailX:'tail.xRatio',tailWidth:'tail.width',tailHeight:'tail.height',tailBorderWidth:'tail.borderWidth',tailY:'tail.yOffset',tailBg:'tail.background',tailBorder:'tail.borderColor',tailLinkColors:'tail.linkColors',
  textAlign:'typography.textAlign',fontSize:'typography.fontSize',lineHeight:'typography.lineHeight',fontWeight:'typography.fontWeight',letterSpacing:'typography.letterSpacing',
  showNick:'nickname.visible',nickColor:'nickname.color',nickSize:'nickname.size',nickGap:'nickname.gap',nickBreak:'nickname.break',showPlatform:'visibility.platform',showBadge:'visibility.badge',
  eventUseBubbleStyle:'eventCards.useBubbleStyle',eventStripServiceSurface:'eventCards.stripServiceSurface',eventBg:'eventCards.background',eventText:'eventCards.textColor',eventBorder:'eventCards.borderColor',eventBorderWidth:'eventCards.borderWidth',eventRadius:'eventCards.radius',donationWidth:'donation.width',donationCenter:'donation.center'
 };
 const defaults=structuredClone(theme());
 function enumValue(value,allowed,fallback){if(value===undefined)return fallback;if(!allowed.includes(value))throw Error('디자인 파일에 지원하지 않는 설정이 있습니다.');return value}
 function numberValue(value,min,max,fallback){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error('디자인 파일의 숫자 설정이 허용 범위를 벗어났습니다.');return value}
 function checkedImage(data){if(typeof data!=='string'||!imagePattern.test(data)||data.length>Math.ceil(MAX_FILE*4/3)+100)throw Error('지원하지 않는 이미지 또는 너무 큰 이미지가 있습니다.');return data}
 function decodeImage(data){return new Promise((resolve,reject)=>{const img=new Image();const timer=setTimeout(()=>{img.src='';reject(Error('이미지를 여는 데 시간이 너무 오래 걸립니다.'))},10000);img.onload=()=>{clearTimeout(timer);if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth>8192||img.naturalHeight>8192||img.naturalWidth*img.naturalHeight>24000000){reject(Error('이미지 크기를 8,192px 이하, 2,400만 화소 이하로 줄여 주세요.'));return}resolve({aspectRatio:img.naturalWidth/img.naturalHeight})};img.onerror=()=>{clearTimeout(timer);reject(Error('이미지 파일을 열 수 없습니다.'))};img.src=data})}
 async function validateDesign(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||![33,34,35].includes(raw.version)||!raw.bubble||!raw.layout||!Array.isArray(raw.decorations))throw Error('채팅창 꾸미기에서 저장한 디자인 JSON 파일을 선택해 주세요.');
  const values={};
  for(const [id,path] of Object.entries(controls)){
   const el=$(id);let value=read(raw,path);if(value===undefined)value=read(defaults,path);
   if(id==='patternOpacity')value*=100;
   if(el.type==='checkbox'){if(typeof value!=='boolean')throw Error('디자인 파일의 선택 설정이 올바르지 않습니다.')}
   else if(el.tagName==='SELECT'){value=enumValue(String(value),[...el.options].map(o=>o.value))}
   else if(el.type==='color'){if(typeof value!=='string'||!/^#[a-f0-9]{6}$/i.test(value))throw Error('디자인 파일의 색상 설정이 올바르지 않습니다.')}
   else{value=numberValue(value,el.min!==''?Number(el.min):-10000,el.max!==''?Number(el.max):10000)}
   values[id]=value;
  }
  if(raw.decorations.length>MAX_IMAGES)throw Error('이미지는 최대 20장까지 불러올 수 있습니다.');
  const layers=[];
  for(const item of raw.decorations){
   const dataUrl=checkedImage(item?.dataUrl),meta=await decodeImage(dataUrl);
   const layer={dataUrl,aspectRatio:meta.aspectRatio,name:typeof item.name==='string'?item.name.slice(0,120):'장식 이미지',visible:item.visible!==false};
   layer.scope=enumValue(item.scope,['bubble','overlay'],'bubble');layer.positionMode=enumValue(item.positionMode,['smart','anchor','ratio'],'smart');
   for(const key of ['xTarget','xSelf'])layer[key]=enumValue(item[key],key==='xTarget'?['left','center','right','free']:['left','center','right'],'left');
   for(const key of ['yTarget','ySelf'])layer[key]=enumValue(item[key],key==='yTarget'?['top','center','bottom','free']:['top','center','bottom'],'center');
   layer.anchor=enumValue(item.anchor,['top-left','top-center','top-right','center-left','center','center-right','bottom-left','bottom-center','bottom-right'],'center-left');
   layer.width=numberValue(item.width,8,500,56);
   for(const key of ['xOffset','yOffset','offsetX','offsetY'])layer[key]=numberValue(item[key],-10000,10000,0);
   for(const key of ['xRatio','yRatio'])layer[key]=numberValue(item[key],-100,200,0);
   layers.push(layer);
  }
  return{values,layers,adapter:enumValue(raw.adapter,['weflab','generic'],null)};
 }
 function savedTheme(){return{...theme(),adapter:environmentChosen?$('adapter').value:undefined,product:'byeollog-chat-studio',savedAt:new Date().toISOString()}}
 function saveDesign(){const text=JSON.stringify(savedTheme(),null,2);if(new Blob([text]).size>MAX_DESIGN){notify('디자인이 너무 큽니다. 이미지 크기나 개수를 줄인 뒤 저장해 주세요.',true);return}dl('byeollog-chat-design.json',text,'application/json');dirty=false;notify('디자인 파일을 저장했습니다. 다음에는 ‘디자인 불러오기’로 열어 주세요.')}
 $('saveDesign').onclick=saveDesign;$('saveDesignTop').onclick=saveDesign;$('downloadJson').onclick=saveDesign;
 $('loadDesign').onclick=()=>{if(uploadBusy){notify('이미지를 불러오는 중입니다. 잠시 후 다시 눌러 주세요.');return}$('designFile').click()};
 $('designFile').addEventListener('change',async e=>{
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  $('loadDesign').disabled=true;
  try{
   if(file.size>MAX_DESIGN)throw Error('디자인 파일은 24MB 이하로 선택해 주세요.');
   const next=await validateDesign(JSON.parse(await file.text()));
   if(dirty&&!confirm('현재 작업을 불러온 디자인으로 바꿀까요? 저장하지 않은 변경사항은 사라집니다.'))return;
   importing=true;
   for(const [id,value] of Object.entries(next.values)){const el=$(id);if(el.type==='checkbox')el.checked=value;else el.value=String(value)}
   decorations=next.layers.map(l=>({...l,id:uid()}));selected={type:null,id:null,instance:0};
   if(next.adapter)chooseEnvironment(next.adapter);
   else{environmentChosen=false;document.body.classList.add('environment-pending');$('environmentGate').classList.remove('hidden');$('environmentHelp').textContent='사용 환경을 선택해 주세요.';document.querySelectorAll('[data-adapter-choice]').forEach(b=>b.classList.remove('active'))}
   refresh();dirty=false;notify('디자인을 불러왔습니다.'+(next.adapter?'':' 사용할 환경을 선택해 주세요.'));
  }catch(err){notify(err instanceof SyntaxError?'디자인 파일을 읽을 수 없습니다. 저장한 JSON 파일인지 확인해 주세요.':err.message,true)}
  finally{importing=false;$('loadDesign').disabled=false}
 });
 $('imageUpload').addEventListener('change',async e=>{
  const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;uploadBusy=true;e.target.disabled=true;$('loadDesign').disabled=true;
  try{
   if(decorations.length+files.length>MAX_IMAGES)throw Error('이미지는 최대 20장까지 추가할 수 있습니다.');
   const next=[];
   for(const file of files){
    if(file.size>MAX_FILE||!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw Error('PNG·JPG·WebP·GIF 파일을 장당 8MB 이하로 선택해 주세요.');
    const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('이미지 파일을 읽을 수 없습니다.'));r.readAsDataURL(file)});
    const meta=await decodeImage(checkedImage(dataUrl));
    next.push({id:uid(),name:file.name,scope:'bubble',dataUrl,aspectRatio:meta.aspectRatio,width:56,positionMode:'smart',xTarget:'left',xSelf:'left',yTarget:'center',ySelf:'center',xRatio:0,yRatio:50,xOffset:0,yOffset:0,anchor:'center-left',offsetX:-14,offsetY:0,visible:true});
   }
   if(new Blob([JSON.stringify({...savedTheme(),decorations:[...decorations,...next]})]).size>MAX_DESIGN)throw Error('전체 디자인이 24MB를 넘습니다. 이미지 크기를 줄여 주세요.');
   decorations.push(...next);selectLayer(decorations.at(-1).id,0);refresh();dirty=true;notify(`${next.length}개 이미지를 추가했습니다.`);
  }catch(err){notify(err.message,true)}finally{uploadBusy=false;e.target.disabled=false;$('loadDesign').disabled=false}
 });
 $('copyCss').onclick=async()=>{try{await navigator.clipboard.writeText($('output').value);notify('CSS를 복사했습니다. 사용 중인 채팅 서비스의 커스텀 CSS에 붙여 넣어 주세요.')}catch{const details=$('output').closest('details');details.open=true;$('output').focus();$('output').select();notify('자동 복사가 허용되지 않았습니다. 선택된 CSS를 직접 복사해 주세요.',true)}};
 function showPreview(preview){document.body.classList.toggle('preview-mobile',preview);$('showPreview').setAttribute('aria-pressed',String(preview));$('showEditor').setAttribute('aria-pressed',String(!preview));if(preview)requestAnimationFrame(()=>{setFrame();const stage=$('previewStage'),t=theme();stage.scrollLeft=t.layout.alignment==='right'?Math.max(0,t.canvas.x+t.canvas.width-stage.clientWidth+16):0})}
 $('showEditor').onclick=()=>showPreview(false);$('showPreview').onclick=()=>showPreview(true);
 document.querySelectorAll('[data-adapter-choice]').forEach(b=>b.addEventListener('click',()=>{
  const text=$('exportTitle').nextElementSibling;
  text.textContent=b.dataset.adapterChoice==='weflab'?'위플랩의 커스텀 CSS에 붙여 넣으세요. 적용 후 방송 미리보기에서 확인해 주세요.':'직접 만든 HTML 채팅창에 적용하는 CSS입니다. CSS만으로 채팅이 수집되지는 않습니다.';
 }));
 // Explicit labels without changing the existing control layout.
 document.querySelectorAll('.control').forEach(row=>{const label=row.querySelector('label'),input=row.querySelector('input,select');if(label&&input?.id)label.htmlFor=input.id});
 const exportModal=$('exportModal');let priorFocus;
 $('applyBtn').addEventListener('click',()=>{if(!environmentChosen)return;priorFocus=document.activeElement;requestAnimationFrame(()=>$('copyCss').focus())});
 $('exportClose').addEventListener('click',()=>priorFocus?.focus());
 exportModal.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const elements=[...exportModal.querySelectorAll('button,textarea,summary')].filter(el=>el.getClientRects().length&&!el.disabled&&el.tabIndex>=0);const first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}});
 // Exposed only for local verification; no credentials or network state exist here.
 window.ByeollogChatStudio=Object.freeze({validateDesign,savedTheme});
})();


