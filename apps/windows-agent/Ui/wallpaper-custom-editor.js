(() => {
  const appearance=globalThis.ByeollogWallpaperAppearance,bridge=globalThis.wallpaperBaekdusanBridge;
  if(!appearance||!bridge)return;
  const {state,request,flushWallpaperEdits,initializeWallpaperEditor,renderWallpaper,status}=bridge;
  const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;if(tag==='button')el.type='button';return el;};
  document.getElementById('openWallpaperCustomBtn').onclick=()=>{
    if(document.getElementById('wallpaperCustomDialog'))return;
    let busy=false,fontChecked='',draft={...appearance.defaults,...state.wallpaper?.appearance};
    const dialog=element('dialog',undefined,'wallpaper-custom-dialog');dialog.id='wallpaperCustomDialog';dialog.setAttribute('aria-labelledby','wallpaperCustomTitle');
    const header=element('header',undefined,'wallpaper-custom-head'),heading=element('div'),title=element('h2','풍벽지 커스텀');title.id='wallpaperCustomTitle';
    heading.append(title,element('p','내 방송에 맞는 카드 스타일을 만들어보세요.'));const close=element('button','닫기');close.onclick=()=>{if(!busy)dialog.close();};header.append(heading,close);
    const body=element('div',undefined,'wallpaper-custom-body'),fields=element('div',undefined,'wallpaper-custom-fields'),preview=element('aside',undefined,'wallpaper-custom-preview');body.append(fields,preview);
    const footer=element('footer',undefined,'wallpaper-custom-footer'),message=element('div','', 'wallpaper-custom-status');message.id='wallpaperCustomStatus';message.setAttribute('role','status');
    const reset=element('button','기본 스타일로 복원'),cancel=element('button','취소'),save=element('button','저장하고 적용','primary');save.id='saveWallpaperCustomBtn';reset.id='resetWallpaperCustomBtn';cancel.onclick=close.onclick;footer.append(message,reset,cancel,save);
    dialog.append(header,body,footer);document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>{dialog.remove();document.getElementById('openWallpaperCustomBtn')?.focus();});
    function field(parent,label,id,type,value){const wrap=element('label',undefined,'wallpaper-custom-field'),input=element(type==='select'?'select':'input');input.id=id;if(type!=='select')input.type=type;input.value=value;wrap.append(element('span',label),input);parent.append(wrap);return {wrap,input};}
    const font=field(fields,'폰트 파일 링크','wallpaperCustomFont','url',draft.fontUrl);font.input.placeholder='https://…/font.woff2';font.input.autocomplete='off';font.input.maxLength=2048;
    const fontRow=element('div',undefined,'wallpaper-custom-font-row'),checkFont=element('button','폰트 확인');font.input.replaceWith(fontRow);fontRow.append(font.input,checkFont);
    font.wrap.append(element('small','WOFF2 · WOFF · TTF · OTF 파일의 HTTPS 주소. 비워두면 기본 폰트를 사용합니다.'));
    const colors=element('div',undefined,'wallpaper-custom-colors');fields.append(colors);
    const name=field(colors,'후원자 닉네임','wallpaperCustomNameColor','color',draft.nameColor),text=field(colors,'후원 수량 글자','wallpaperCustomTextColor','color',draft.textColor),background=field(colors,'글자 영역 배경','wallpaperCustomBackground','color',draft.backgroundColor);
    fields.append(element('p','배경색은 닉네임·후원 수량 뒤에만 적용됩니다. 후원 이미지 영역은 투명하게 유지됩니다.','wallpaper-custom-note'));
    fields.append(element('p','작은 카드의 한 줄 표시는 그대로 유지됩니다. 같은 폰트와 닉네임·후원 수량 색상이 한 줄에도 적용됩니다.','wallpaper-custom-note'));
    const sizeWrap=element('div',undefined,'wallpaper-custom-field'),sizeTitle=element('label','글자 크기');sizeTitle.htmlFor='wallpaperCustomSize';const sizeRow=element('div',undefined,'wallpaper-custom-size'),slider=element('input'),number=element('input');slider.type='range';slider.id='wallpaperCustomSize';number.type='number';number.id='wallpaperCustomSizeNumber';number.setAttribute('aria-label','글자 크기 픽셀');slider.step=number.step='1';sizeRow.append(slider,number);const rangeText=element('small');rangeText.id='wallpaperCustomSizeRange';sizeWrap.append(sizeTitle,sizeRow,rangeText);fields.append(sizeWrap);
    fields.append(element('p','이 PC의 현재 계정에 저장됩니다. 일반 카드·묶음 해제 카드·백두산의 채워진 칸에 적용되며, 후원 기록과 카드 배치는 유지됩니다.','wallpaper-custom-note'));
    preview.append(element('h3','카드 미리보기'));
    const choice=field(preview,'크기 기준 카드','wallpaperCustomSample','select','');
    const realCanvas=document.querySelector('#wallpaperPreview .wallpaper-editor-canvas');
    const samples=appearance.entries(realCanvas||document.createElement('div')).slice(0,216).map(({card,meta})=>({width:card.clientWidth,height:card.clientHeight,metaHeight:meta.clientHeight,image:card.querySelector('img')?.getAttribute('src')||'',compact:card.classList.contains('compact-label'),label:(card.querySelector('.wallpaper-meta-info')?.textContent||'풍벽지')})).filter(x=>x.width>0&&x.height>0);
    if(!samples.length)samples.push({width:240,height:226,metaHeight:46,image:'',compact:false,label:'기본 카드'});
    if(!samples.some(s=>s.compact))samples.push({width:80,height:75,metaHeight:16,image:samples[0].image,compact:true,label:'작은 카드 예시'});
    const seen=new Set();const unique=samples.filter(s=>{const k=[s.width,s.height,s.metaHeight,s.compact].join(':');if(seen.has(k))return false;seen.add(k);return true;});
    for(const [i,sample]of unique.entries()){const option=element('option',`${sample.label} · ${sample.width} × ${sample.height}px`);option.value=String(i);choice.input.append(option);}
    const stage=element('div',undefined,'wallpaper-custom-stage'),canvas=element('div'),card=element('article',undefined,'wallpaper-tile wallpaper-custom-sample'),image=element('img'),meta=element('div',undefined,'wallpaper-meta');image.alt='';
    const sampleName=element('span','별록후원자','wallpaper-meta-name'),sampleInfo=element('span','별풍선 1,000개','wallpaper-meta-info'),compact=element('span','별록후원자 1,000개','wallpaper-meta-compact');meta.append(sampleName,sampleInfo,compact);card.append(image,meta);canvas.append(card);stage.append(canvas);preview.append(stage);
    const previewNote=element('p','', 'wallpaper-custom-preview-note');previewNote.id='wallpaperCustomPreviewNote';preview.append(previewNote);
    function values(){return appearance.normalize({enabled:true,fontUrl:font.input.value,nameColor:name.input.value,textColor:text.input.value,backgroundColor:background.input.value,fontSize:Number(number.value)});}
    function updateRange(changeSize=false){
      const sample=unique[Number(choice.input.value)||0];card.style.width=sample.width+'px';card.style.height=sample.height+'px';card.classList.toggle('compact-label',sample.compact);card.style.gridTemplateRows=`minmax(0,1fr) ${sample.metaHeight}px`;
      if(sample.image){image.src=sample.image;image.style.display='block';image.style.visibility='visible';}else{image.removeAttribute('src');image.style.visibility='hidden';image.style.display=sample.metaHeight>=sample.height-4?'none':'block';if(image.style.display==='none')card.style.gridTemplateRows='1fr';}
      const range=appearance.bounds(sample.width,sample.metaHeight,appearance.linesFor(card));slider.min=number.min=String(range.min);slider.max=number.max=String(range.max);
      const wanted=changeSize?Number(number.value):draft.fontSize;number.value=slider.value=String(Math.max(range.min,Math.min(range.max,Number.isFinite(wanted)?wanted:18)));
      const scale=Math.min(1,300/sample.width,230/sample.height);card.style.transform=`scale(${scale})`;canvas.style.width=sample.width*scale+'px';canvas.style.height=sample.height*scale+'px';card.style.transformOrigin='top left';
      rangeText.textContent=`이 카드에서 ${range.min}~${range.max}px 사용 가능 · ${sample.compact?'한 줄':'두 줄'} 카드 기준`;
      previewNote.textContent='다른 크기의 카드는 각 카드의 허용 범위 안에서 글자 크기를 자동 조절합니다. 긴 닉네임은 말줄임으로 표시됩니다.';
      repaint();
    }
    function repaint(){try{const v=values();draft=v;appearance.apply(canvas,v);}catch(error){message.textContent=error.message;}}
    async function verifyFont(){const url=appearance.fontUrl(font.input.value.trim());message.textContent=url?'폰트를 불러오는 중입니다…':'기본 폰트를 사용합니다.';await appearance.loadFont(url,true);if(!dialog.isConnected||font.input.value.trim()!==url)return;fontChecked=url;delete canvas.dataset.appearanceFont;repaint();message.textContent=url?'폰트를 확인했습니다. 미리보기에 반영했습니다.':'기본 폰트를 사용합니다.';}
    checkFont.onclick=async()=>{if(busy)return;checkFont.disabled=true;try{await verifyFont();}catch(error){message.textContent=error.message;}finally{checkFont.disabled=false;}};
    font.input.onchange=()=>{fontChecked='';};
    for(const control of [name.input,text.input,background.input])control.oninput=repaint;
    slider.oninput=()=>{number.value=slider.value;repaint();};number.oninput=()=>{slider.value=number.value;repaint();};choice.input.onchange=()=>updateRange(true);
    async function persist(action){
      if(busy)return;busy=true;const controls=[...dialog.querySelectorAll('button,input,select')];for(const c of controls)c.disabled=true;
      try{
        let settings;
        if(action==='appearance-save'){settings=values();const range=appearance.bounds(meta.clientWidth,meta.clientHeight,appearance.linesFor(card));if(settings.fontSize<range.min||settings.fontSize>range.max)throw Error(`이 카드의 글자 크기는 ${range.min}~${range.max}px로 설정해주세요.`);if(settings.fontUrl!==fontChecked)await verifyFont();}
        message.textContent='저장하는 중입니다…';if(!await flushWallpaperEdits())throw Error('진행 중인 배치 저장을 먼저 완료해주세요.');
        const next=await request('wallpaper-control',{method:'POST',body:JSON.stringify({action,appearance:settings})});state.wallpaper=next;initializeWallpaperEditor();renderWallpaper();dialog.close();
        status('wallpaperStatus',action==='appearance-reset'?'기본 카드 스타일로 복원했습니다.':'풍벽지 커스텀을 저장했습니다. OBS에도 반영됩니다.','ok');
      }catch(error){message.textContent=error.message;}finally{busy=false;for(const c of controls)c.disabled=false;}
    }
    save.onclick=()=>persist('appearance-save');reset.onclick=()=>persist('appearance-reset');updateRange();
    if(state.wallpaper?.appearance?.error){message.textContent=state.wallpaper.appearance.error;save.disabled=reset.disabled=true;}
  };
})();
