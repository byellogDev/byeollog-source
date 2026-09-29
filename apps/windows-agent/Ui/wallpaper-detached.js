/* One shared card geometry/rendering contract for the native editor and OBS. */
globalThis.ByeollogDetached = (() => {
  const matches = (tile, view) => (tile.displayKind || 'donation') === 'donation'
    && (view?.ranges || []).some(r => Number(tile.amount) >= r.min && Number(tile.amount) <= r.max);
  function cards(tiles, view, sizeRules = [], owned = new Set()) {
    return (tiles || []).filter(t => matches(t, view) && !owned.has(t.id)).map(tile => {
      const saved = view?.positions?.[tile.id];
      const rule = sizeRules.find(r => tile.amount >= r.min && tile.amount <= r.max);
      const width = saved?.width || rule?.width || 240;
      const height = saved?.height || Math.max(20, Math.round(width * (tile.imageUrl ? 226 : 46) / 240));
      return {...tile, x:saved?.x || 0, y:saved?.y || 0, width, height};
    });
  }
  function render(canvas, tiles, view, rules, owned, move, select) {
    const list = cards(tiles, view, rules, owned), ids = new Set(list.map(c => c.id));
    const nodes = new Map([...canvas.querySelectorAll(':scope > .wallpaper-detached')].map(n => [n.dataset.tileId,n]));
    for (const [id,node] of nodes) if (!ids.has(id)) node.remove();
    for (const [index,card] of list.entries()) {
      let node = nodes.get(card.id);
      if (!node) {
        node = document.createElement('article'); node.className = 'wallpaper-detached'; node.dataset.tileId = card.id;
        const image = document.createElement('img'), meta = document.createElement('div'), name = document.createElement('strong'), amount = document.createElement('span');
        image.alt = ''; image.draggable = false;
        Object.assign(image.style,{display:'block',width:'100%',minHeight:'0',flex:'1',objectFit:'contain',objectPosition:'center bottom',pointerEvents:'none'});
        Object.assign(meta.style,{background:'#fffffff0',border:'1px solid #dce4ee',color:'#111',display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',flexShrink:'0',boxSizing:'border-box',overflow:'hidden',lineHeight:'1.1'});
        Object.assign(name.style,{color:'#ed3128',maxWidth:'100%',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
        meta.append(name,amount); node.append(image,meta); canvas.append(node);
        Object.assign(node.style,{position:'absolute',display:'flex',flexDirection:'column',boxSizing:'border-box',userSelect:'none',touchAction:'none',fontFamily:'"Malgun Gothic",sans-serif',fontWeight:'900'});
      }
      if (node.dataset.dragging || node.dataset.saving) continue;
      Object.assign(node.style,{left:card.x+'px',top:card.y+'px',width:card.width+'px',height:card.height+'px',zIndex:String(500+index),pointerEvents:move?'auto':'none',cursor:move?'grab':'default'});
      node.tabIndex = move ? 0 : -1; node.setAttribute('aria-label',`${card.actorName || '익명'} · 별풍선 ${card.amount}개 · 개별 카드`);
      node.onfocus = () => { if(move) { node.style.outline = '3px solid #37d6bd'; select?.(); } };
      node.onblur = () => { node.style.outline = ''; };
      const [image,meta] = node.children;
      if(card.imageUrl){if(image.getAttribute('src')!==card.imageUrl)image.src=card.imageUrl;image.style.display='block';}
      else {image.removeAttribute('src');image.style.display='none';}
      meta.style.height = (card.imageUrl ? 46/226*100 : 100)+'%';
      meta.style.fontSize = Math.max(5, Math.min(21,card.width/13,card.height/(card.imageUrl?12:2.5)))+'px';
      meta.children[0].textContent = card.actorName || '익명'; meta.children[1].textContent = '별풍선 '+Number(card.amount).toLocaleString('ko-KR')+'개';
      const save = async position => {
        node.dataset.saving='true';
        try { await move(card,position); Object.assign(card,position); node.style.left=position.x+'px';node.style.top=position.y+'px'; }
        finally { delete node.dataset.saving; }
      };
      node.onpointerdown = move ? event => {
        if(event.button!==0 || node.dataset.saving)return;
        event.preventDefault();event.stopPropagation();node.focus();node.setPointerCapture(event.pointerId);
        const scale=canvas.getBoundingClientRect().width/1920,startX=event.clientX,startY=event.clientY;
        let x=card.x,y=card.y;node.dataset.dragging='true';node.style.cursor='grabbing';
        node.onpointermove=e=>{e.stopPropagation();x=Math.max(0,Math.min(1920-card.width,Math.round(card.x+(e.clientX-startX)/scale)));y=Math.max(0,Math.min(1080-card.height,Math.round(card.y+(e.clientY-startY)/scale)));node.style.left=x+'px';node.style.top=y+'px';};
        const end=async e=>{
          e.stopPropagation();node.onpointermove=null;node.onpointerup=null;node.onpointercancel=null;delete node.dataset.dragging;node.style.cursor='grab';
          if(node.hasPointerCapture(e.pointerId))node.releasePointerCapture(e.pointerId);
          if(e.type!=='pointercancel'&&(x!==card.x||y!==card.y)) {
            try {await save({x,y,width:card.width,height:card.height});}catch{node.style.left=card.x+'px';node.style.top=card.y+'px';}
          }else{node.style.left=card.x+'px';node.style.top=card.y+'px';}
        };node.onpointerup=end;node.onpointercancel=end;
      } : null;
      node.onkeydown=move?async e=>{
        const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
        if(!delta||node.dataset.saving)return;e.preventDefault();e.stopPropagation();
        const step=e.shiftKey?10:1;
        try{await save({x:Math.max(0,Math.min(1920-card.width,card.x+delta[0]*step)),y:Math.max(0,Math.min(1080-card.height,card.y+delta[1]*step)),width:card.width,height:card.height});}catch{}
      }:null;
    }
    return list;
  }
  return {matches,cards,render};
})();
