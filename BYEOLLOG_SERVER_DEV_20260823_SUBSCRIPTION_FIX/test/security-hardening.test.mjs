import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import handler from '../api/data.js';

const root=new URL('../',import.meta.url);

async function source(relativePath){
  return readFile(new URL(relativePath,import.meta.url),'utf8');
}

test('superseded Agent RPCs remain installed but are not client executable',async()=>{
  const sql=await source('../supabase/migrations/20260825101500_revoke_superseded_agent_rpcs.sql');
  for(const signature of [
    /public\.save_guided_rule_v8\([\s\S]*?from public,anon,authenticated,service_role/i,
    /public\.save_guided_rule_v9\([\s\S]*?from public,anon,authenticated,service_role/i,
    /public\.save_guided_rule_v10\([\s\S]*?from public,anon,authenticated,service_role/i,
    /public\.get_raffle_state_v1\(uuid\)[\s\S]*?from public,anon,authenticated,service_role/i
  ]) assert.match(sql,signature);

  const client=await source('../../BYEOLLOG_AGENT_DEV_v07022/VNextAutomationClient.cs');
  assert.doesNotMatch(client,/save_guided_rule_v(?:8|9|10)|get_raffle_state_v1/);
  assert.match(client,/save_guided_rule_v11/);
  assert.match(client,/get_raffle_state_v2/);
});

function createResponse(){
  return {
    statusCode:200,
    headers:{},
    body:undefined,
    status(code){this.statusCode=code;return this},
    setHeader(name,value){this.headers[String(name).toLowerCase()]=String(value);return this},
    json(value){this.body=value;return this},
    send(value){this.body=value;return this},
    end(){return this}
  };
}

async function withPublicProxyEnvironment(fetchImpl,run){
  const originalFetch=globalThis.fetch;
  const originalValues={
    SUPABASE_URL:process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY:process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL='https://project.example.invalid';
  process.env.SUPABASE_SECRET_KEY='test-secret-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-service-role-key';
  globalThis.fetch=fetchImpl;
  try{return await run()}
  finally{
    globalThis.fetch=originalFetch;
    for(const [name,value] of Object.entries(originalValues)){
      if(value===undefined)delete process.env[name];
      else process.env[name]=value;
    }
  }
}

test('public viewer uses the same-origin server proxy and exposes no Supabase key',async()=>{
  const html=await readFile(new URL('bangsel_public_workspace_isolation.html',root),'utf8');
  assert.match(html,/\/api\/data\?operation=public-workspace/);
  assert.match(html,/\/api\/data\?operation=public-bangsel/);
  assert.doesNotMatch(html,/\.supabase\.co\/rest\/v1\/rpc/);
  assert.doesNotMatch(html,/sb_publishable_/);
});

test('public data proxy is fixed to two read-only RPCs and validates inputs',async()=>{
  const source=await readFile(new URL('api/data.js',root),'utf8');
  assert.match(source,/'public-workspace':'get_public_workspace'/);
  assert.match(source,/'public-bangsel':'get_public_bangsel'/);
  assert.match(source,/if\(req\.method!=='POST'\)/);
  assert.match(source,/\^\[a-z0-9\]\[a-z0-9_-\]\{1,62\}\$/);
  assert.match(source,/search\.length>100/);
  assert.match(source,/Authorization:'Bearer '\+serviceRoleKey/);
  assert.match(source,/catch\{\s*return res\.status\(502\)\.json\(\{message:'Public data service is unavailable'\}\);/);
});

test('public data proxy calls only the expected service-role RPC',async()=>{
  let request;
  await withPublicProxyEnvironment(async(url,options)=>{
    request={url:String(url),options};
    return new Response(JSON.stringify([{slug:'sample',display_name:'Sample',public_page_enabled:true}]),{
      status:200,
      headers:{'content-type':'application/json'}
    });
  },async()=>{
    const res=createResponse();
    await handler({
      method:'POST',
      query:{operation:'public-workspace'},
      body:{p_workspace_slug:' Sample '}
    },res);
    assert.equal(res.statusCode,200);
    assert.match(String(res.body),/"slug":"sample"/);
  });
  assert.equal(request.url,'https://project.example.invalid/rest/v1/rpc/get_public_workspace');
  assert.equal(request.options.method,'POST');
  assert.equal(request.options.headers.Authorization,'Bearer test-service-role-key');
  assert.deepEqual(JSON.parse(request.options.body),{p_workspace_slug:'sample'});
});

test('public data proxy rejects invalid input without contacting Supabase',async()=>{
  let fetchCalls=0;
  await withPublicProxyEnvironment(async()=>{fetchCalls+=1;throw new Error('unexpected fetch')},async()=>{
    const methodRes=createResponse();
    await handler({method:'GET',query:{operation:'public-workspace'},body:{}},methodRes);
    assert.equal(methodRes.statusCode,405);

    const workspaceRes=createResponse();
    await handler({method:'POST',query:{operation:'public-workspace'},body:{p_workspace_slug:'../bad'}},workspaceRes);
    assert.equal(workspaceRes.statusCode,400);

    const searchRes=createResponse();
    await handler({
      method:'POST',
      query:{operation:'public-bangsel'},
      body:{p_workspace_slug:'sample',p_search:'x'.repeat(101)}
    },searchRes);
    assert.equal(searchRes.statusCode,400);
  });
  assert.equal(fetchCalls,0);
});

test('public data proxy does not disclose upstream error details',async()=>{
  await withPublicProxyEnvironment(async()=>new Response(
    JSON.stringify({message:'sensitive database detail'}),
    {status:500,headers:{'content-type':'application/json'}}
  ),async()=>{
    const res=createResponse();
    await handler({
      method:'POST',
      query:{operation:'public-workspace'},
      body:{p_workspace_slug:'sample'}
    },res);
    assert.equal(res.statusCode,500);
    assert.deepEqual(res.body,{message:'Public data query failed'});
  });
});

test('migration removes browser execution and adds explicit policies to all 27 tables',async()=>{
  const pregrant=await readFile(new URL('supabase/migrations/20260823010650_grant_public_rpc_service_role.sql',root),'utf8');
  const sql=await readFile(new URL('supabase/migrations/20260823011107_harden_public_rpc_and_rls.sql',root),'utf8');
  assert.equal((pregrant.match(/grant execute/g)||[]).length,2);
  assert.doesNotMatch(pregrant,/revoke|security invoker|create policy/i);
  assert.equal((sql.match(/security invoker;/g)||[]).length,2);
  assert.equal((sql.match(/from public, anon, authenticated;/g)||[]).length,2);
  assert.equal((sql.match(/to service_role;/g)||[]).length,2);
  assert.equal((sql.match(/create policy explicitly_deny_direct_client_access/g)||[]).length,27);
  assert.equal((sql.match(/using \(false\) with check \(false\);/g)||[]).length,27);
});

test('multiplier state is RLS-protected and foreign keys have covering indexes',async()=>{
  const hardening=await readFile(new URL(
    'supabase/migrations/20260823055539_harden_multiplier_rls_and_fk_indexes.sql',root),'utf8');
  const policies=await readFile(new URL(
    'supabase/migrations/20260823060109_add_multiplier_explicit_deny_policies.sql',root),'utf8');

  assert.equal((hardening.match(/enable row level security;/g)||[]).length,2);
  assert.match(hardening,/bangsel_tasks \(workspace_id, fan_soop_id\)/);
  assert.match(hardening,/byeollog_audit_log \(actor_user_id\)/);
  assert.match(hardening,/byeollog_dashboard_handoffs \(device_id\)/);
  assert.match(hardening,/byeollog_workspaces \(owner_user_id\)/);
  assert.equal((policies.match(/create policy explicitly_deny_direct_client_access/g)||[]).length,2);
  assert.equal((policies.match(/to anon, authenticated/g)||[]).length,2);
  assert.equal((policies.match(/using \(false\)[\s\S]*?with check \(false\);/g)||[]).length,2);
});

test('API failures never return raw internal exception details',async()=>{
  for(const directory of ['api','lib']){
    const files=(await readdir(new URL(`${directory}/`,root)))
      .filter(name=>name.endsWith('.js'));
    for(const name of files){
      const source=await readFile(new URL(`${directory}/${name}`,root),'utf8');
      assert.doesNotMatch(
        source,
        /detail\s*:\s*(?:String\s*\(|[A-Za-z_$][\w$]*\??\.message|[^,}\n]*\.message)/,
        `${directory}/${name} exposes an internal exception message`
      );
    }
  }
});

test('runtime configuration validator is present and never prints secret values',async()=>{
  const source=await readFile(new URL('scripts/validate-runtime-config.mjs',root),'utf8');
  assert.match(source,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source,/BYEOLLOG_AUTOMATION_SESSION_MODE/);
  assert.match(source,/PLATFORM_ADMIN_EMAILS/);
  assert.match(source,/Secret values were not printed/);
  assert.doesNotMatch(source,/console\.(?:log|error)\([^\n]*(?:process\.env|current|value\()/);
});
