/* Shared rendering for the local editor and OBS. Never inserts user CSS/HTML. */
globalThis.ByeollogWallpaperAppearance = (() => {
  const defaults = Object.freeze({enabled:false,fontUrl:'',nameColor:'#e33732',textColor:'#161616',backgroundColor:'#ffffff',fontSize:18});
  const fonts = new Map(); let serial = 0;
  function fontUrl(value) {
    if (!value) return '';
    let url; try { url = new URL(value); } catch { throw Error('웹폰트 파일의 전체 HTTPS 링크를 입력해주세요.'); }
    if (value.length>2048 || url.protocol!=='https:' || url.port || url.username || url.password || url.hash || !/\.(woff2?|ttf|otf)$/i.test(url.pathname) || /^(localhost|127\.|\[|\d+\.\d+\.\d+\.\d+$)/i.test(url.hostname))
      throw Error('HTTPS 웹폰트 파일 링크(.woff2, .woff, .ttf, .otf)를 입력해주세요. CSS 페이지 주소는 지원하지 않습니다.');
    return value;
  }
  function normalize(value={}) {
    const result={...defaults,...value};
    result.fontUrl=fontUrl(String(result.fontUrl||'').trim());
    for(const key of ['nameColor','textColor','backgroundColor'])if(!/^#[a-f0-9]{6}$/i.test(result[key]))throw Error('색상은 #RRGGBB 형식으로 입력해주세요.');
    if(!Number.isInteger(result.fontSize)||result.fontSize<4||result.fontSize>72)throw Error('글자 크기는 4~72px 사이여야 합니다.');
    return result;
  }
  function bounds(width,height,lines=2) {
    const max=Math.max(4,Math.min(72,Math.floor(Math.min((Math.max(0,height)-4)/(lines*1.18+.2),Math.max(0,width)/(lines===1?8:4.4)))));
    return {min:Math.min(8,max),max};
  }
  function loadFont(raw,retry=false) {
    const url=fontUrl(raw);if(!url)return Promise.resolve('"Noto Sans KR",Pretendard,"Malgun Gothic",sans-serif');
    let item=fonts.get(url);if(item && (!item.failed || (!retry && Date.now()-item.at<60000)))return item.promise;
    const family='ByeollogCustom'+(++serial),face=new FontFace(family,`url(${JSON.stringify(url)})`);
    item={face,at:Date.now(),failed:false};fonts.set(url,item);
    let timeout;
    item.promise=Promise.race([face.load(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('font_timeout')),10000);})])
      .then(()=>{document.fonts.add(face);return '"'+family+'",sans-serif';})
      .catch(()=>{item.failed=true;throw Error('폰트를 불러오지 못했습니다. 파일 링크와 외부 사용 허용(CORS)을 확인해주세요.');})
      .finally(()=>clearTimeout(timeout));
    while(fonts.size>4){const key=fonts.keys().next().value;document.fonts.delete(fonts.get(key).face);fonts.delete(key);}
    return item.promise;
  }
  const css=`
  .wallpaper-custom-card{background:var(--wallpaper-custom-bg)!important}
  .wallpaper-custom-meta{background:var(--wallpaper-custom-bg)!important;color:var(--wallpaper-custom-text)!important;font-family:var(--wallpaper-custom-font,"Malgun Gothic",sans-serif)!important;font-size:var(--wallpaper-custom-size)!important;line-height:1.18!important;letter-spacing:normal!important;text-shadow:none!important;box-sizing:border-box!important;min-height:0;overflow:hidden!important}
  .wallpaper-custom-meta>:not(.wallpaper-meta-name):not(strong):not(.wallpaper-custom-compact){color:var(--wallpaper-custom-text)!important}
  .wallpaper-custom-meta .wallpaper-meta-name,.wallpaper-custom-meta>strong,.wallpaper-custom-meta[data-filled]>span:not(.wallpaper-custom-compact){color:var(--wallpaper-custom-name)!important}
  .wallpaper-custom-meta .wallpaper-meta-info{font-size:1em!important}
  .wallpaper-custom-meta{align-items:center!important;justify-content:center!important;gap:0!important;padding:0 2px!important}
  .wallpaper-custom-meta>*,.wallpaper-custom-compact>*{font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
  .wallpaper-custom-meta.wallpaper-custom-double{display:flex!important;flex-direction:column!important}
  .wallpaper-custom-double>.wallpaper-meta-name,.wallpaper-custom-double>.wallpaper-meta-info{display:block!important}
  .wallpaper-custom-double>.wallpaper-meta-compact,.wallpaper-custom-double>.wallpaper-custom-compact{display:none!important}
  .wallpaper-custom-single>:not(.wallpaper-custom-compact){display:none!important}
  .wallpaper-custom-meta>.wallpaper-custom-compact{display:block;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .wallpaper-custom-compact>strong{color:var(--wallpaper-custom-name)!important;font-weight:inherit}
  .wallpaper-custom-compact>span{color:var(--wallpaper-custom-text)!important}
  `;
  function install() { if(document.getElementById('wallpaperAppearanceStyles'))return;const style=document.createElement('style');style.id='wallpaperAppearanceStyles';style.textContent=css;document.head.append(style); }
  function entries(canvas) {
    return [...canvas.querySelectorAll('.wallpaper-tile,.wallpaper-detached,.baekdusan-region [data-filled="true"]')].map(card=>({card,meta:card.matches('[data-filled]')?card:card.querySelector('.wallpaper-meta')||card.children[1]})).filter(x=>x.meta);
  }
  function linesFor(card){return card.classList.contains('compact-label')?1:2;}
  function compactParts(name,copy){
    return name&&copy.startsWith(name)?[{name:true,text:name},{name:false,text:copy.slice(name.length)}]:[{name:false,text:copy}];
  }
  function apply(canvas,value) {
    if(!canvas)return;install();let settings;try{settings=normalize(value);}catch{settings={...defaults};}
    const items=entries(canvas);
    for(const {card,meta} of items){
      card.classList.toggle('wallpaper-custom-card',settings.enabled);
      meta.classList.toggle('wallpaper-custom-meta',settings.enabled);
      meta.classList.remove('wallpaper-custom-single','wallpaper-custom-double');
      if(!settings.enabled){meta.querySelector('.wallpaper-custom-compact')?.remove();continue;}
      const lines=linesFor(card),range=bounds(meta.clientWidth,meta.clientHeight,lines);
      meta.classList.add(lines===1?'wallpaper-custom-single':'wallpaper-custom-double');
      meta.style.setProperty('--wallpaper-custom-size',Math.max(range.min,Math.min(range.max,settings.fontSize))+'px');
      if(lines===1){
        let compact=meta.querySelector('.wallpaper-custom-compact');
        if(!compact){compact=document.createElement('span');compact.className='wallpaper-custom-compact';meta.append(compact);}
        const name=meta.querySelector('.wallpaper-meta-name')||([...meta.children].find(x=>x.tagName==='STRONG'))||(card.matches('[data-filled]')?[...meta.children].find(x=>x.tagName==='SPAN'&&x!==compact):null);
        const copy=meta.querySelector('.wallpaper-meta-compact')?.textContent||'';
        const parts=compactParts(name?.textContent||'',copy),key=JSON.stringify(parts);
        if(compact.dataset.copy!==key){compact.replaceChildren(...parts.map(part=>{const node=document.createElement(part.name?'strong':'span');node.textContent=part.text;return node;}));compact.dataset.copy=key;}
      }
    }
    canvas.style.setProperty('--wallpaper-custom-name',settings.nameColor);canvas.style.setProperty('--wallpaper-custom-text',settings.textColor);canvas.style.setProperty('--wallpaper-custom-bg',settings.backgroundColor);
    const url=settings.enabled?settings.fontUrl:'',key=url+':'+(settings.version||0);
    if(canvas.dataset.appearanceFont!==key){
      canvas.dataset.appearanceFont=key;delete canvas.dataset.appearanceFontError;canvas.style.removeProperty('--wallpaper-custom-font');
      loadFont(url).then(family=>{if(canvas.dataset.appearanceFont===key){canvas.style.setProperty('--wallpaper-custom-font',family);delete canvas.dataset.appearanceFontError;}}).catch(()=>{if(canvas.dataset.appearanceFont===key)canvas.dataset.appearanceFontError='true';});
    }
  }
  return {defaults,normalize,fontUrl,bounds,loadFont,entries,linesFor,compactParts,apply};
})();
