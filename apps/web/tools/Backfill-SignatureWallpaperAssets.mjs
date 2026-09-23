import {sb} from '../lib/supabase-rest.js';
import {deriveSignatureWallpaperAsset,removeSignatureAssets} from '../lib/signature-balloon-assets.js';

const rows=await sb('byeollog_signature_balloons','?wallpaper_image=is.null&select=id,workspace_id,pc_image&order=created_at.asc&limit=200');
let completed=0,skipped=0;
for(const row of Array.isArray(rows)?rows:[]){
  const derived=await deriveSignatureWallpaperAsset(row.workspace_id,row.pc_image);
  const {previewUrl:_previewUrl,...reference}=derived;
  const updated=await sb('byeollog_signature_balloons',`?id=eq.${encodeURIComponent(row.id)}&workspace_id=eq.${encodeURIComponent(row.workspace_id)}&wallpaper_image=is.null`,{
    method:'PATCH',prefer:'return=representation',body:{wallpaper_image:reference}
  });
  if(Array.isArray(updated)&&updated.length===1)completed+=1;
  else{
    skipped+=1;
    await removeSignatureAssets([reference.storagePath]);
  }
}
console.log(JSON.stringify({ok:true,completed,skipped}));
