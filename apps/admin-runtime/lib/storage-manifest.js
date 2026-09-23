export function normalizeStorageManifest(manifest){
  if(!Array.isArray(manifest) || manifest.length>10000){
    throw new Error('탈퇴 Storage 목록이 올바르지 않습니다.');
  }
  const seen=new Set();
  const entries=[];
  for(const item of manifest){
    const bucketId=String(item?.bucketId||'').trim();
    const name=String(item?.name||'');
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(bucketId)
      || !name || name.length>1024 || name.startsWith('/') || /[\u0000-\u001f\u007f]/.test(name)){
      throw new Error('탈퇴 Storage 항목이 올바르지 않습니다.');
    }
    const key=`${bucketId}\u0000${name}`;
    if(seen.has(key)) continue;
    seen.add(key);
    entries.push({bucketId,name});
  }
  return entries;
}
