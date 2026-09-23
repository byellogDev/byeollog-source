const DAY=86400000;
const TILES='byeollog_wallpaper_tiles',SESSIONS='byeollog_wallpaper_sessions';
// Preserve every non-wallpaper field, including historical backup versions.
export function pruneWallpaperArchive(input,now=Date.now()){
  if(!input||input.format!=='bangsel-db-backup'||!input.tables||typeof input.tables!=='object'||Array.isArray(input.tables))throw Error('Invalid archive for wallpaper retention');
  const cutoff=now-7*DAY;
  if(!Number.isFinite(cutoff))throw Error('Invalid retention clock');
  const result=structuredClone(input),tables=result.tables;
  const date=value=>{const n=Date.parse(value);if(!Number.isFinite(n))throw Error('Invalid wallpaper retention timestamp');return n;};
  const oldTiles=tables[TILES]??[],oldSessions=tables[SESSIONS]??[];
  if(!Array.isArray(oldTiles)||!Array.isArray(oldSessions))throw Error('Invalid wallpaper archive rows');
  const removedSessions=new Set(),changedSessions=new Set();
  const tiles=oldTiles.filter(row=>{const keep=date(row.received_at)>=cutoff;if(!keep)changedSessions.add(row.session_id);return keep;});
  const retainedSessions=new Set(tiles.map(row=>row.session_id));
  const counts=new Map();for(const tile of tiles)counts.set(tile.session_id,(counts.get(tile.session_id)||0)+1);
  const sessions=oldSessions.filter(row=>{const remove=row.state==='closed'&&date(row.closed_at)<cutoff&&!retainedSessions.has(row.id);if(remove)removedSessions.add(row.id);return !remove;}).map(row=>changedSessions.has(row.id)?{...row,tile_count:counts.get(row.id)||0}:row);
  if(Object.hasOwn(tables,TILES))tables[TILES]=tiles;
  if(Object.hasOwn(tables,SESSIONS))tables[SESSIONS]=sessions;
  // Older archive variants may contain selected broadcast references.
  if(Array.isArray(tables.byeollog_wallpaper_overlay_sessions))tables.byeollog_wallpaper_overlay_sessions=tables.byeollog_wallpaper_overlay_sessions.filter(row=>!removedSessions.has(row.session_id));
  const removedTiles=oldTiles.length-tiles.length,removedBroadcasts=oldSessions.length-sessions.length;
  if(removedTiles||removedBroadcasts){
    for(const name of [TILES,SESSIONS,'byeollog_wallpaper_overlay_sessions'])if(result.table_meta?.[name]&&Array.isArray(tables[name]))result.table_meta[name].row_count=tables[name].length;
  }
  return {backup:result,removedTiles,removedBroadcasts,changed:removedTiles>0||removedBroadcasts>0,cutoff:new Date(cutoff).toISOString()};
}
