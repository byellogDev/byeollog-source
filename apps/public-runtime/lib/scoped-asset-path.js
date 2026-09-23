// Validate before constructing a Storage request or a signed URL. A prefix
// alone is insufficient because URL parsers normalize dot path segments.
export function isScopedAssetPath(value,workspaceId,kind=null){
 if(typeof value!=='string'||value.length>512)return false;
 const parts=value.split('/');
 return parts.length===4&&parts[0]==='workspaces'&&parts[1]===workspaceId
  &&/^[a-z][a-z0-9-]{0,39}$/.test(parts[2])&&(!kind||parts[2]===kind)
  &&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(parts[3]);
}
