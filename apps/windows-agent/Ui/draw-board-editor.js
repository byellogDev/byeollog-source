(() => {
  'use strict';
  const bridge = globalThis.wallpaperBaekdusanBridge;
  if (!bridge) return;
  const {state, request} = bridge;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; if (tag === 'button') n.type = 'button'; return n; };
  const open = el('button', '뽑기판'); open.id = 'openDrawBoardBtn';
  document.getElementById('openWallpaperCustomBtn')?.before(open);
  open.onclick = () => {
    if (document.getElementById('drawBoardDialog')) return;
    const dialog = el('dialog', undefined, 'draw-dialog'); dialog.id = 'drawBoardDialog'; dialog.setAttribute('aria-labelledby', 'drawBoardHeading');
    const head = el('header'), heading = el('div'), title = el('h2', '뽑기판 만들기·진행'); title.id = 'drawBoardHeading';
    heading.append(el('p', '별록 뽑기판', 'draw-kicker'), title);
    const close = el('button', '닫기'); close.onclick = () => { if (!busy) dialog.close(); }; head.append(heading, close);
    const body = el('div', undefined, 'draw-body'), controls = el('section', undefined, 'draw-controls'), stage = el('section', undefined, 'draw-stage');
    const message = el('p', '', 'draw-message'); message.id = 'drawBoardMessage'; message.setAttribute('role', 'status');
    const footer = el('footer'); footer.append(message); body.append(controls, stage); dialog.append(head, body, footer); document.body.append(dialog); dialog.showModal();
    let busy = false, refreshing = false, version = -1, draftId = crypto.randomUUID(), activeId = '', setup = false;
    dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); open.focus(); });
    function field(parent, label, id, value, type = 'text', min, max) {
      const wrap = el('label'), input = el(type === 'select' ? 'select' : 'input'); input.id = id;
      if (type !== 'select') input.type = type; input.value = String(value); if (min !== undefined) input.min = min; if (max !== undefined) input.max = max;
      if (type === 'number') input.step = '1'; wrap.append(el('span', label), input); parent.append(wrap); return input;
    }
    async function mutate(payload) {
      if (busy) return; busy = true; message.textContent = '저장하는 중입니다…'; dialog.dataset.busy = 'true';
      const buttons = [...controls.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
      try {
        state.wallpaper = await request('wallpaper-control', {method: 'POST', body: JSON.stringify(payload)});
        setup = false; activeId = ''; version = -1; render(); message.textContent = '저장했습니다. OBS에도 같은 결과가 표시됩니다.';
      } catch (error) { message.textContent = error.message; }
      finally { busy = false; delete dialog.dataset.busy; buttons.forEach(b => b.disabled = false); }
    }
    function grid(board, preview = false) {
      stage.replaceChildren(); const bar = el('div', undefined, 'draw-stage-title');
      bar.append(el('h3', board.title || '오늘의 뽑기판'), el('span', preview ? '설정 미리보기' : `${board.results.length} / ${board.size}칸 확정`)); stage.append(bar);
      const tiles = el('div', undefined, 'draw-grid'); tiles.style.setProperty('--draw-columns', board.columns); tiles.style.setProperty('--draw-rows', Math.ceil(board.size / board.columns));
      const results = new Map(board.results.map(r => [r.number, r]));
      for (let n = 1; n <= board.size; n++) {
        const r = results.get(n), cell = el('div', undefined, 'draw-cell' + (r ? r.prize ? ' is-win' : ' is-blank' : ''));
        cell.append(el('span', String(n), 'draw-number'));
        if (r) { cell.append(el('strong', r.prize || '꽝')); if (r.actor) cell.append(el('small', r.actor)); }
        tiles.append(cell);
      }
      stage.append(tiles, el('p', preview ? '상품 위치는 시작할 때 무작위로 고정됩니다. 남은 칸은 꽝으로 채웁니다.' : '확정된 결과를 표시합니다. 방송에서는 번호 강조 후 한 칸씩 순서대로 공개됩니다.', 'draw-note'));
    }
    function setupForm() {
      setup = true; activeId = ''; controls.replaceChildren(); controls.append(el('h3', '새 뽑기판 설정'));
      const name = field(controls, '뽑기판 이름', 'drawTitle', '오늘의 뽑기판'); name.maxLength = 60; name.required = true;
      const mode = field(controls, '진행 방식', 'drawMode', '', 'select');
      for (const [v, t] of [['random', '후원이 들어오면 랜덤 추첨'], ['manual', '직접 번호 입력']]) { const option = el('option', t); option.value = v; mode.append(option); }
      const dimensions = el('div', undefined, 'draw-fields'); controls.append(dimensions);
      const size = field(dimensions, '전체 칸 수', 'drawSize', 100, 'number', 1, 500), columns = field(dimensions, '한 줄 칸 수', 'drawColumns', 10, 'number', 1, 20);
      const auto = el('div', undefined, 'draw-auto'); controls.append(auto);
      const session = field(auto, '후원을 받을 방송', 'drawSession', '', 'select');
      for (const s of state.wallpaper?.sessions || []) { const option = el('option', `${new Date(s.startedAt || s.started_at).toLocaleString('ko-KR')} · ${s.label || '방송'}`); option.value = s.id; session.append(option); }
      const amounts = el('div', undefined, 'draw-fields'); auto.append(amounts);
      const amount = field(amounts, '별풍선 수량', 'drawAmount', 100, 'number', 1, 1000000), draws = field(amounts, '후원당 추첨 횟수', 'drawCount', 1, 'number', 1, 20);
      auto.append(el('p', '시작 후 수집된 일반 별풍선만 적용합니다. 설정 수량과 정확히 일치해야 하며, 미션·구독은 제외됩니다.', 'draw-note'));
      const prizes = el('div', undefined, 'draw-prizes'), add = el('button', '상품 추가'); controls.append(el('h4', '상품과 수량'), prizes, add);
      function addPrize(label = '', count = 1) {
        const row = el('div', undefined, 'draw-prize-row'), text = el('input'), number = el('input'), remove = el('button', '삭제');
        text.placeholder = '상품 이름'; text.maxLength = 60; text.required = true; text.value = label; text.setAttribute('aria-label', '상품 이름');
        number.type = 'number'; number.min = 1; number.max = 500; number.step = 1; number.value = count; number.setAttribute('aria-label', '상품 수량');
        remove.onclick = () => { row.remove(); preview(); }; row.append(text, number, remove); prizes.append(row); row.oninput = preview;
      }
      add.onclick = () => { if (prizes.children.length < 100) addPrize(); }; addPrize('당첨', 5);
      const summary = el('p', '', 'draw-note'); controls.append(summary);
      const start = el('button', '이 설정으로 시작', 'draw-primary'); start.id = 'startDrawBoardBtn';
      const note = el('p', '시작 후 모드·상품·수량은 바꿀 수 없습니다. 이 PC에 계정별로 저장되며 Agent 실행 중에만 자동 추첨합니다.', 'draw-note'); controls.append(note, start);
      function preview() {
        const count = Math.max(1, Math.min(500, Number(size.value) || 1)), cols = Math.max(1, Math.min(20, count, Number(columns.value) || 1));
        const allocated = [...prizes.children].reduce((sum, r) => sum + (Number(r.children[1].value) || 0), 0);
        summary.textContent = allocated > count ? `상품이 ${allocated - count}개 초과합니다.` : `상품 ${allocated}칸 · 꽝 ${count - allocated}칸`;
        auto.hidden = mode.value === 'manual'; grid({title: name.value, size: count, columns: cols, results: []}, true);
      }
      for (const input of [name, size, columns, mode]) input.oninput = preview;
      start.onclick = () => {
        if (![...controls.querySelectorAll('input')].every(n => n.reportValidity())) return;
        void mutate({action: 'draw-board-create', id: draftId, title: name.value, mode: mode.value, size: Number(size.value), columns: Number(columns.value), amount: Number(amount.value), draws: Number(draws.value), sessionId: session.value,
          prizes: [...prizes.children].map(r => ({name: r.children[0].value, count: Number(r.children[1].value)}))});
      };
      preview();
    }
    function render() {
      const view = state.wallpaper?.drawBoard || {}, board = view.board;
      if (setup) return;
      if (!board) { setupForm(); if (view.error) message.textContent = view.error; return; }
      if (version === view.version) return;
      version = view.version; grid(board);
      if (activeId !== board.id + ':' + board.ended) {
        activeId = board.id + ':' + board.ended; controls.replaceChildren();
        controls.append(el('h3', board.title), el('p', board.ended ? '종료된 뽑기판' : board.mode === 'random' ? `별풍선 ${board.amount}개마다 ${board.draws}회 자동 추첨` : '직접 번호를 입력해 공개하세요.', 'draw-mode'));
        const copy = el('button', 'OBS 오버레이 주소 복사', 'draw-primary'); copy.id = 'copyDrawBoardBtn';
        const url = new URL(state.wallpaper?.overlayUrl || 'http://127.0.0.1:43120/overlay/wallpaper'); url.pathname = '/overlay/draw-board'; url.search = '';
        copy.onclick = async () => { try { await navigator.clipboard.writeText(url.href); message.textContent = 'OBS 브라우저 소스에 붙여넣으세요. 권장 크기: 1920 × 1080'; } catch { message.textContent = '아래 주소를 직접 복사해주세요.'; } };
        const address = el('input'); address.readOnly = true; address.value = url.href; address.setAttribute('aria-label', 'OBS 오버레이 주소'); address.onclick = () => address.select(); controls.append(copy, address, el('p', '미리보기와 OBS는 같은 판을 표시합니다. OBS 새로고침으로 재추첨되지 않습니다.', 'draw-note'));
        if (!board.ended && board.mode === 'manual') {
          const number = field(controls, '공개할 번호', 'drawManualNumber', '', 'number', 1, board.size); number.required = true;
          const reveal = el('button', '이 번호 공개', 'draw-primary'); reveal.id = 'revealDrawBoardBtn';
          reveal.onclick = () => { if (number.reportValidity()) void mutate({action: 'draw-board-reveal', id: board.id, number: Number(number.value)}); };
          number.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); reveal.click(); } }; controls.append(reveal);
        }
        if (!board.ended) {
          const stop = el('button', '이 뽑기판 종료'); stop.onclick = () => {
            const confirm = el('button', '종료 확정 · 결과는 보관됩니다', 'draw-danger'); confirm.onclick = () => void mutate({action: 'draw-board-stop', id: board.id}); stop.replaceWith(confirm);
          }; controls.append(stop);
        } else { const next = el('button', '새 뽑기판 만들기'); next.onclick = () => { draftId = crypto.randomUUID(); setupForm(); }; controls.append(next); }
        const history = el('details'); history.append(el('summary', '이전 뽑기판 기록'));
        for (const old of view.history || []) {
          const item = el('details'); item.append(el('summary', `${old.title} · ${old.count}/${old.size}칸`));
          let loaded = false, loading = false;
          item.ontoggle = async () => {
            if (!item.open || loaded || loading) return;
            loading = true;
            try {
              const detail = await request('wallpaper-control', {method: 'POST', body: JSON.stringify({action: 'draw-board-history', id: old.id})});
              if (!item.isConnected) return;
              for (const r of detail.results) item.append(el('p', `${r.number}번 · ${r.prize || '꽝'}${r.actor ? ' · ' + r.actor : ''}`));
              if (!detail.results.length) item.append(el('p', '공개된 번호가 없습니다.'));
              loaded = true;
            } catch (error) { message.textContent = error.message; }
            finally { loading = false; }
          }; history.append(item);
        }
        controls.append(history);
      }
      if (view.error) message.textContent = view.error;
    }
    render();
    const timer = setInterval(async () => {
      if (busy || refreshing || setup || !dialog.isConnected || document.visibilityState !== 'visible') return;
      refreshing = true;
      try { const next = await request('wallpaper-control'); if (!dialog.isConnected || busy || (next.drawBoard?.version ?? 0) < (state.wallpaper?.drawBoard?.version ?? 0)) return; state.wallpaper = next; render(); }
      catch (error) { if (dialog.isConnected) message.textContent = error.message; }
      finally { refreshing = false; }
    }, 1500);
  };
})();
