/* Shared by the native editor and localhost OBS page. No network or HTML from tips. */
globalThis.ByeollogBaekdusan = (() => {
  const active = view => (view?.runs || []).filter(r => (view.selectedSessionIds || []).includes(r.sessionId));
  const owned = view => new Set(active(view).flatMap(r => r.members.map(t => t.id)));
  function render(canvas, view, edit) {
    const runs = active(view), ids = new Set(runs.map(r => r.id));
    for (const node of canvas.querySelectorAll(':scope > .baekdusan-region')) if (!ids.has(node.dataset.id)) node.remove();
    for (const run of runs) {
      let node = [...canvas.querySelectorAll(':scope > .baekdusan-region')].find(n => n.dataset.id === run.id);
      const key = JSON.stringify(run);
      if (node?.dataset.dragging === "true" || node?.dataset.key === key) continue;
      if (!node) { node = document.createElement('section'); node.className = 'baekdusan-region'; node.dataset.id = run.id; canvas.append(node); }
      node.dataset.key = key;
      Object.assign(node.style, {position:'absolute',left:run.x+'px',top:run.y+'px',width:run.width+'px',height:run.height+'px',
        boxSizing:'border-box',padding:'12px',border:'2px solid #ffcc62',borderRadius:'18px',background:'#091b30ed',
        color:'#fff',fontFamily:'"Malgun Gothic",sans-serif',display:'flex',flexDirection:'column',gap:'8px',zIndex:'10000',overflow:'hidden',pointerEvents:edit?'auto':'none'});
      const header = document.createElement(edit?'button':'div');
      const complete = run.members.length === run.target-run.start+1;
      header.textContent = `백두산 ${run.start}–${run.target} · ${run.members.length}/${run.target-run.start+1} ${complete?'완주!':run.closed?'방송 종료':'진행 중'}`+(edit?' · 배치 설정':'');
      Object.assign(header.style,{fontSize:'24px',fontWeight:'900',color:'#ffdc8c',background:'transparent',border:'0',padding:'0',textAlign:'left',flexShrink:'0'});
      if (edit) header.onclick = event => { event.stopPropagation(); edit(run); };
      const grid = document.createElement('div');
      Object.assign(grid.style,{display:'grid',gridTemplateColumns:`repeat(${run.columns},minmax(0,1fr))`,gridTemplateRows:`repeat(${Math.ceil((run.target-run.start+1)/run.columns)},minmax(0,1fr))`,gap:'4px',flex:'1',minHeight:'0'});
      const font = Math.max(8,Math.min(24,(run.width-24)/run.columns/4,(run.height-64)/Math.ceil((run.target-run.start+1)/run.columns)/3));
      for(let amount=run.start;amount<=run.target;amount++) {
        const tip = run.members[amount-run.start], cell = document.createElement('div');
        Object.assign(cell.style,{minWidth:'0',minHeight:'0',overflow:'hidden',borderRadius:'5px',border:tip?'1px solid #77e6bf':'1px dashed #4b6381',
          background:tip?'#174d46':'#12253d',color:tip?'#fff':'#8398b2',display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',fontSize:font+'px'});
        cell.dataset.amount=String(amount);cell.dataset.filled=String(Boolean(tip));
        const number=document.createElement('b');number.textContent=String(amount);cell.append(number);
        if(tip){const name=document.createElement('span');name.textContent=tip.actorName;Object.assign(name.style,{maxWidth:'100%',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});cell.title=`${tip.actorName} · ${tip.amount}개 · ${tip.receivedAt}`;cell.append(name);}
        grid.append(cell);
      }
      node.replaceChildren(header,grid);
      if(edit) node.onpointerdown = event => {
        if(event.target.closest('button') || event.button!==0)return;
        event.preventDefault();event.stopPropagation();
        const startX=event.clientX,startY=event.clientY,scale=canvas.getBoundingClientRect().width/1920;
        let x=run.x,y=run.y,moved=false;node.dataset.dragging='true';node.setPointerCapture(event.pointerId);
        node.onpointermove=e=>{e.stopPropagation();x=Math.max(0,Math.min(1920-run.width,Math.round(run.x+(e.clientX-startX)/scale)));y=Math.max(0,Math.min(1080-run.height,Math.round(run.y+(e.clientY-startY)/scale)));moved ||= Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)>3;node.style.left=x+'px';node.style.top=y+'px';};
        const end=e=>{e.stopPropagation();delete node.dataset.dragging;node.dataset.key='';node.onpointermove=null;node.onpointerup=null;node.onpointercancel=null;if(node.hasPointerCapture(e.pointerId))node.releasePointerCapture(e.pointerId);if(moved&&e.type!=='pointercancel')edit(run,{x,y});else render(canvas,view,edit);};
        node.onpointerup=end;node.onpointercancel=end;
      };
    }
  }
  return {active,owned,render};
})();
