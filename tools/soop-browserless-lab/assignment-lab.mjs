import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {handleSoopGatewayIngress} from '../../apps/admin-runtime/lib/soop-gateway-api.js';
import {signSoopGatewayRequest} from '../../apps/admin-runtime/lib/soop-chat-gateway.js';
import {verifySoopGatewayLease,assertSoopGatewayOwnership} from '../../apps/admin-runtime/lib/soop-gateway-lease.js';
globalThis.fetch=async()=>{throw Error('External network prohibited in assignment lab')};
const workspaceId='10000000-0000-4000-8000-000000000001',broadcasterId='synthetic_broadcaster';
const secret='synthetic-assignment-secret-not-production';
const env={SOOP_GATEWAY_INGRESS_ENABLED:'true',SOOP_GATEWAY_INGRESS_SECRET:secret};
let writes=0,reads=0;
async function lease(instanceId){
  const body={kind:'lease',workspaceId,instanceId},timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
  const req={method:'POST',headers:{'content-type':'application/json','x-byeollog-soop-gateway-timestamp':timestamp,'x-byeollog-soop-gateway-nonce':nonce,'x-byeollog-soop-gateway-signature':signSoopGatewayRequest({secret,timestamp,nonce,body})},body};
  const res={statusCode:200,status(v){this.statusCode=v;return this},setHeader(){},json(v){this.body=v;return this}};
  await handleSoopGatewayIngress(req,res,{env,sbImpl:async(table,path,opts)=>{
    if(opts?.method&&opts.method!=='GET')writes++;else reads++;
    if(table==='byeollog_workspaces')return [{id:workspaceId,soop_id:broadcasterId,status:'active'}];
    if(table==='byeollog_soop_runtime_controls')return [{gateway_enabled:true,core_collection_enabled:true}];
    throw Error('Unexpected database access');
  },oauthConfig:()=>({clientId:'synthetic',clientSecret:'synthetic'}),refreshConnection:async()=>({accessToken:'synthetic',expiresAt:new Date(Date.now()+3600000).toISOString(),refreshed:false})});
  assert.equal(res.statusCode,200);return res.body;
}
const results=await Promise.all([lease('worker-a'),lease('worker-b')]);
const claims=results.map(x=>verifySoopGatewayLease(x.leaseToken,env));
for(const claim of claims)assertSoopGatewayOwnership({body:{workspaceId,instanceId:claim.instanceId,room:{bjId:broadcasterId,chatNumber:1}},claims:claim,requireRoom:true});
assert.equal(writes,0);assert.notEqual(claims[0].instanceId,claims[1].instanceId);
const report={at:new Date().toISOString(),scope:'Actual canonical lease/ownership code with synthetic DB/OAuth dependencies. No production traffic.',concurrentWorkers:2,leasesIssued:2,bothPassOwnership:true,dbReads:reads,dbWrites:writes,conclusion:'Authorization leases are not exclusive worker assignments; no takeover fencing is enforced by this path.'};
fs.writeFileSync(new URL('../../.local/soop-browserless-lab/assignment-result.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
