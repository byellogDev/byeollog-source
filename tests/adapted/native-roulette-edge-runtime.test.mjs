import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(auditURL(path,import.meta.url),'utf8');

test('native roulette ingress uses an isolated Edge runtime instead of a thirteenth Vercel function',async()=>{
  const [edge,ignore]=await Promise.all([
    source('../supabase/functions/native-roulette-runtime/index.ts'),
    source('../.vercelignore')
  ]);
  assert.match(ignore,/^api\/native-roulette\.js$/m);
  assert.match(edge,/Deno\.env\.get\("NATIVE_ROULETTE_ENABLED"\) === "true"/);
  assert.match(edge,/Deno\.env\.get\("SOOP_CHAT_SDK_ENABLED"\) === "true"/);
  assert.match(edge,/if \(!enabled\(\)\) return json\(\{ error: "not_found" \}, 404\)/);
});
test('native roulette Edge ingress binds user session, runtime release, workspace and Agent secret',async()=>{
  const edge=await source('../supabase/functions/native-roulette-runtime/index.ts');
  assert.match(edge,/createServerRuntime\(request, "native_roulette_runtime", RUNTIME_REVISION\)/);
  assert.match(edge,/assertAutomationRuntimeReleaseActive\(runtime,workspaceId,"native_roulette_runtime",RUNTIME_REVISION\)/);
  assert.match(edge,/rpc\/g3a_authenticate_agent_device_v1/);
  assert.match(edge,/p_device_secret_hash: deviceSecretHash/);
  assert.match(edge,/rpc\/ingest_native_roulette_soop_donation_v1/);
  assert.match(edge,/rpc\/ingest_native_roulette_soop_chat_v1/);
});

test('native roulette Edge ingress validates replay and latency evidence before database ingestion',async()=>{
  const edge=await source('../supabase/functions/native-roulette-runtime/index.ts');
  assert.match(edge,/relay\.schemaVersion !== 1/);
  assert.match(edge,/relay\.provider !== "soop"/);
  assert.match(edge,/rawPayloadSha256/);
  assert.match(edge,/connection\.sequence/);
  assert.match(edge,/transportLatencyMs/);
  assert.match(edge,/MAX_BODY_BYTES = 64 \* 1024/);
});
