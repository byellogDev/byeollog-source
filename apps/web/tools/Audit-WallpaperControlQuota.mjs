// Offline diagnostic: execute the current handler with fake auth/rate storage.
// Never imports production clients or sends network requests.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../api/login.js',import.meta.url),'utf8');
const start=source.indexOf('async function handleAgentWallpaperControl(req,res){');
const end=source.indexOf('\nasync function handleSoopWallpaperOverlayPage',start);
if(start<0||end<0)throw new Error('Cannot locate current control handler');
const hits=new Map();let rejectedAuth=0,writes=0;
const context={
  UUID:/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  isJsonRequest:()=>true,bearer:req=>req.token,bodyOf:req=>req.body,clientIp:()=> 'fixture-ip',
  isRateLimited:async(key,{limit})=>{const count=(hits.get(key)||0)+1;hits.set(key,count);return count>limit},
  authorizedAgentWorkspace:async token=>{if(token==='valid')return {status:200,user:{id:'fixture'}};rejectedAuth++;return {status:401}},
  runAgentWallpaperControl:async()=>{writes++;return {ok:true}},console
};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
const body={workspaceId:'11111111-1111-4111-8111-111111111111',control:{action:'select-sessions',sessionIds:[]}};
async function request(token){const response={statusCode:0,status(code){this.statusCode=code;return this},json(value){this.body=value;return this}};await context.handleAgentWallpaperControl({method:'POST',token,body},response);return response}
for(let i=0;i<120;i++)await request('invalid');
const valid=await request('valid');
console.log(JSON.stringify({mode:'offline handler with fake auth and counters',invalidTokensRejected:rejectedAuth,validRequestAfterInvalidRequests:valid.statusCode,authorizedWrites:writes,affectedScope:'known workspace selection quota'},null,2));
