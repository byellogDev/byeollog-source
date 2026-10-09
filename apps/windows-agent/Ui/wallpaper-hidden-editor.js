(() => {
  const bridge = globalThis.wallpaperBaekdusanBridge, hidden = globalThis.ByeollogHiddenCards;
  if (!bridge || !hidden) return;
  const {state, commitWallpaperSetting, wallpaperSettingsBusy} = bridge;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; if (tag === 'button') node.type = 'button'; return node; };
  const open = el('button', '숨긴 풍벽지 (0)'); open.id = 'openWallpaperHiddenBtn';
  document.getElementById('openWallpaperCustomBtn').after(open);
  let dialog, list, count, search, previous, next, page = 0, busy = false, lastKey = '';
  const size = 40;
  const copy = card => `${card.actorName || '익명'} · ${Number(card.amount || 0).toLocaleString('ko-KR')}${card.displayKind === 'subscription' ? '개월 구독' : '개'}${card.displayKind === 'challenge_success' ? ' 도전미션 성공' : ''}`;
  const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '받은 시각 없음';
  async function change(id, restore) {
    if (busy || wallpaperSettingsBusy()) return;
    busy = true; render();
    try {
      await commitWallpaperSetting(restore ? 'card-restore' : 'card-hide', {id}, dialog ? 'wallpaperHiddenStatus' : 'wallpaperStatus',
        restore ? '숨김을 해제했습니다. 선택한 방송과 금액별 표시 설정에 따라 나타납니다.' : '풍벽지를 숨겼습니다. ‘숨긴 풍벽지’에서 복원할 수 있습니다.');
    } finally { busy = false; lastKey = ''; render(); }
  }
  function render() {
    const view = state.wallpaper?.hiddenCards;
    const items = Object.values(hidden.records(view));
    open.textContent = `숨긴 풍벽지 (${items.length.toLocaleString('ko-KR')})`;
    const canvas = document.querySelector('#wallpaperPreview .wallpaper-editor-canvas');
    if (canvas) {
      const visible = hidden.apply(canvas, view);
      document.getElementById('wallpaperVisible').textContent = visible.toLocaleString('ko-KR');
      const disabled = busy || wallpaperSettingsBusy() || Boolean(view?.error);
      for (const node of canvas.querySelectorAll(hidden.selector)) {
        let button = node.querySelector(':scope > .wallpaper-card-hide');
        if (!button) {
          button = el('button', '×', 'wallpaper-card-hide');
          button.title = '이 풍벽지 숨기기'; button.setAttribute('aria-label', '이 풍벽지 숨기기');
          button.onpointerdown = e => { e.preventDefault(); e.stopPropagation(); };
          button.onkeydown = e => e.stopPropagation();
          button.onclick = e => { e.preventDefault(); e.stopPropagation(); void change(node.dataset.tileId, false); };
          node.append(button);
        }
        button.disabled = disabled;
        const meta = node.querySelector('.wallpaper-tile-meta') || node.children[1];
        node.style.setProperty('--wallpaper-hide-height', Math.max(12, Math.min(40, meta?.clientHeight || node.clientHeight)) + 'px');
      }
    }
    if (!dialog) return;
    const query = search.value.trim().toLocaleLowerCase();
    const rows = items.filter(card => (copy(card) + ' ' + timestamp(card.receivedAt)).toLocaleLowerCase().includes(query))
      .sort((a,b) => String(b.hiddenAt).localeCompare(String(a.hiddenAt)) || String(a.id).localeCompare(String(b.id)));
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / size) - 1));
    const key = JSON.stringify([view, query, page, busy, wallpaperSettingsBusy()]);
    if (key === lastKey) return; lastKey = key;
    count.textContent = `${rows.length.toLocaleString('ko-KR')}개${rows.length ? ` · ${page + 1}/${Math.ceil(rows.length / size)} 페이지` : ''}`;
    list.replaceChildren();
    for (const card of rows.slice(page * size, (page + 1) * size)) {
      const row = el('li', undefined, 'wallpaper-hidden-row'), text = el('div'), restore = el('button', '복원');
      text.append(el('strong', copy(card)), el('small', timestamp(card.receivedAt)));
      restore.dataset.restoreId = card.id; restore.setAttribute('aria-label', copy(card) + ' 복원');
      restore.disabled = busy || wallpaperSettingsBusy() || Boolean(view?.error);
      restore.onclick = () => change(card.id, true); row.append(text, restore); list.append(row);
    }
    if (!rows.length) list.append(el('li', query ? '검색 결과가 없습니다.' : '숨긴 풍벽지가 없습니다. 카드의 × 버튼으로 숨길 수 있습니다.', 'wallpaper-hidden-empty'));
    previous.disabled = busy || page === 0; next.disabled = busy || (page + 1) * size >= rows.length;
    if (view?.error) document.getElementById('wallpaperHiddenStatus').textContent = view.error;
  }
  open.onclick = () => {
    if (dialog) return;
    dialog = el('dialog', undefined, 'wallpaper-hidden-dialog'); dialog.id = 'wallpaperHiddenDialog'; dialog.setAttribute('aria-labelledby', 'wallpaperHiddenTitle');
    const header = el('header'), heading = el('div'), title = el('h2', '숨긴 풍벽지'), close = el('button', '닫기'); title.id = 'wallpaperHiddenTitle';
    heading.append(title, el('p', '이 PC · 현재 계정에서 숨긴 카드')); header.append(heading, close);
    const note = el('p', '후원 기록은 그대로 보관됩니다. 복원한 카드는 해당 방송과 금액이 표시 중일 때 원래 자리에 나타납니다. 방송 기록 보관 기간(최근 7일)이 지난 카드는 다시 표시되지 않습니다.', 'wallpaper-hidden-note');
    search = el('input'); search.type = 'search'; search.placeholder = '후원자 · 수량 · 날짜 검색'; search.setAttribute('aria-label', '숨긴 풍벽지 검색'); search.oninput = () => { page = 0; render(); };
    count = el('p', '', 'wallpaper-hidden-count'); list = el('ul', undefined, 'wallpaper-hidden-list');
    const footer = el('footer'), message = el('div'); message.id = 'wallpaperHiddenStatus'; message.setAttribute('role', 'status');
    previous = el('button', '이전'); next = el('button', '다음'); previous.onclick = () => { page--; render(); }; next.onclick = () => { page++; render(); }; footer.append(message, previous, next);
    close.onclick = () => { if (!busy) dialog.close(); }; dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); dialog = null; open.focus(); });
    dialog.append(header, note, search, count, list, footer); document.body.append(dialog); page = 0; lastKey = ''; render(); dialog.showModal(); search.focus();
  };
  globalThis.ByeollogHiddenEditor = {render}; render();
})();
