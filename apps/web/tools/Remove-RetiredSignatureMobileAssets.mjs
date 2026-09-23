import {sb} from '../lib/supabase-rest.js';
import {removeSignatureAssets} from '../lib/signature-balloon-assets.js';

const execute=process.argv.includes('--execute');
const rows=await sb('byeollog_signature_balloons','?mobile_image=not.is.null&select=workspace_id,mobile_image&limit=1000');
const paths=[];
for(const row of Array.isArray(rows)?rows:[]){
  const path=String(row?.mobile_image?.storagePath||'');
  const expected=`workspaces/${String(row?.workspace_id||'').toLowerCase()}/mobile/`;
  if(!path.startsWith(expected))throw new Error('A stored mobile image is outside its workspace scope.');
  paths.push(path);
}
if(execute&&paths.length)await removeSignatureAssets(paths);
console.log(JSON.stringify({mode:execute?'executed':'dry-run',rows:paths.length,uniqueObjects:new Set(paths).size}));
