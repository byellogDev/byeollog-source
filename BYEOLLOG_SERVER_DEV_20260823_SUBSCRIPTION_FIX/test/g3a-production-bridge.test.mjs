import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import dataHandler from '../api/data.js';

const contract=await readFile(new URL('../lib/collector-automation-session-contract.js',import.meta.url),'utf8');
const pair=await readFile(new URL('../api/collector-pair.js',import.meta.url),'utf8');
const assetHandler=await readFile(new URL('../api/data.js',import.meta.url),'utf8');
const vercelConfig=await readFile(new URL('../vercel.json',import.meta.url),'utf8');

test('production source is pinned to the exact dormant G3A contract',()=>{
  assert.match(contract,/AUTOMATION_SESSION_MODE='offsl-vnext-g3a-v1'/);
  assert.match(contract,/REQUIRED_AUTOMATION_SCHEMA_REVISION='offsl-vnext-g3a-v1'/);
  assert.match(pair,/rpc\/g3a_automation_schema_readiness_v1/);
  assert.match(pair,/process\.env\.BYEOLLOG_AUTOMATION_SESSION_MODE\|\|AUTOMATION_SESSION_MODE/);
  assert.match(pair,/process\.env\.BYEOLLOG_AUTOMATION_PROJECT_URL\|\|OFFSL_AUTOMATION_PROJECT_URL/);
  assert.match(contract,/OFFSL_AUTOMATION_PROJECT_URL='https:\/\/offslvwaugvjotkywlus\.supabase\.co'/);
  assert.match(contract,/OFFSL_AUTOMATION_PROJECT_REF='offslvwaugvjotkywlus'/);
});

test('public bridge enrolls only through the service-derived release contract',()=>{
  assert.match(contract,/PUBLIC_AUTOMATION_RELEASE_EVIDENCE='[0-9a-f]{64}'/);
  assert.match(pair,/rpc\/byeollog_ensure_automation_workspace_v1/);
  assert.match(pair,/p_release_evidence:PUBLIC_AUTOMATION_RELEASE_EVIDENCE/);
  assert.ok(
    pair.indexOf('rpc/byeollog_ensure_automation_workspace_v1')
      < pair.indexOf('rpc/g3a_automation_schema_readiness_v1')
  );
  assert.match(pair,/Existing disabled rows are never re-enabled/);
  assert.match(pair,/\[collector-pair:automation\] omitted/);
  assert.match(pair,/let stage='enrollment'/);
  assert.match(pair,/omit\(stage\+'_error',error\)/);
});

test('legacy Collector pairing remains the primary response path',()=>{
  assert.match(pair,/registerDirectDevice/);
  assert.match(pair,/buildAccountAutomationFields/);
  assert.match(pair,/\.\.\.automationFields/);
  assert.match(pair,/Automation is additive/);
});

test('binary deployment assets are served through a verified compatibility endpoint',()=>{
  assert.match(assetHandler,/Deployment asset integrity check failed/);
  assert.match(assetHandler,/Content-Type','image\/png/);
  assert.match(vercelConfig,/\/api\/data\?operation=deployment-asset&name=byeollog_logo_dark\.png/);
  assert.match(vercelConfig,/\/api\/data\?operation=deployment-asset&name=byeollog_app_icon\.png/);

  let statusCode=0;
  let body=null;
  const headers=new Map();
  const response={
    setHeader:(name,value)=>headers.set(name,value),
    status:(value)=>{statusCode=value;return response},
    send:(value)=>{body=value;return response},
    end:()=>response,
    json:(value)=>{body=value;return response}
  };
  dataHandler({method:'GET',query:{operation:'deployment-asset',name:'byeollog_logo_dark.png'}},response);
  assert.equal(statusCode,200);
  assert.equal(headers.get('Content-Type'),'image/png');
  assert.equal(body.length,102778);
});
