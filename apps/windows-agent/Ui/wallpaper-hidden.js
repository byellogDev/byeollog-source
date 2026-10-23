/* Shared presentation only: compact ordinary stacks, preserve source/layout identity. */
globalThis.ByeollogHiddenCards = (() => {
  const selector = '.wallpaper-tile[data-tile-id],.wallpaper-detached[data-tile-id],.baekdusan-region [data-tile-id]';
  const records = view => view?.cards || {};
  function visibleGroups(groups, view) {
    const hidden = records(view);
    // Keep tileIds and the saved group layout, including a hidden anchor card.
    // Restoration and moving a group must still include its original members.
    return (groups || []).map(group => ({...group, tiles: group.tiles.filter(tile => !Object.hasOwn(hidden, tile.id))}))
      .filter(group => group.tiles.length > 0);
  }
  function apply(canvas, view) {
    let visible = 0;
    for (const node of canvas.querySelectorAll(selector)) {
      const hidden = Object.hasOwn(records(view), node.dataset.tileId);
      node.dataset.cardHidden = String(hidden);
      node.style.visibility = hidden ? 'hidden' : '';
      if (hidden) node.setAttribute('aria-hidden', 'true'); else { node.removeAttribute('aria-hidden'); visible++; }
      // A hidden detached card must not remain in keyboard navigation.
      if (node.classList.contains('wallpaper-detached')) node.tabIndex = hidden || !node.onpointerdown ? -1 : 0;
    }
    return visible;
  }
  return {selector, records, visibleGroups, apply};
})();
