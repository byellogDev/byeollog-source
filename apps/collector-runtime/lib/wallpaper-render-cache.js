// Cache on the DOM node, so replacing/removing a panel cannot retain a stale key.
export function wallpaperRenderChanged(node,value) {
  const key=JSON.stringify(value);
  if(node.__wallpaperRenderKey===key)return false;
  node.__wallpaperRenderKey=key;
  return true;
}
export const wallpaperRenderCacheScript=wallpaperRenderChanged.toString();
