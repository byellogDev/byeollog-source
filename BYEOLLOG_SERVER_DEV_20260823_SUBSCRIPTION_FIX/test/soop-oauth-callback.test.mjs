import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import handler from '../api/login.js';

delete process.env.SOOP_OAUTH_ENABLED;

function createResponse(){
  return {
    statusCode:200,
    headers:{},
    body:undefined,
    status(code){this.statusCode=code;return this},
    setHeader(name,value){this.headers[String(name).toLowerCase()]=String(value);return this},
    send(value){this.body=value;return this},
    end(){return this}
  };
}

test('Vercel routes the registered SOOP redirect URL through the existing auth function',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.ok(config.rewrites.some(rule=>
    rule.source==='/api/auth/soop/callback'&&
    rule.destination==='/api/login?operation=soop-callback'
  ));
  assert.ok(config.rewrites.some(rule=>
    rule.source==='/api/auth/soop/start'&&
    rule.destination==='/api/login?operation=soop-start'
  ));
  assert.ok(config.rewrites.some(rule=>
    rule.source==='/api/auth/soop/status'&&
    rule.destination==='/api/login?operation=soop-status'
  ));
});

test('SOOP callback readiness probe returns a secure no-store page',async()=>{
  const res=createResponse();
  await handler({method:'GET',query:{operation:'soop-callback'},headers:{}},res);
  assert.equal(res.statusCode,200);
  assert.match(res.body,/SOOP 연동 콜백이 준비되었습니다/);
  assert.equal(res.headers['cache-control'],'no-store, private');
  assert.match(res.headers['content-security-policy'],/default-src 'none'/);
  assert.equal(res.headers['x-robots-tag'],'noindex, noarchive');
});

test('SOOP callback recognizes authCode without storing or exposing OAuth values',async()=>{
  const authCode='sensitive-auth-code-value';
  const state='sensitive-state-value';
  const res=createResponse();
  await handler({
    method:'GET',
    query:{operation:'soop-callback',authCode,state},
    headers:{}
  },res);
  assert.equal(res.statusCode,200);
  assert.match(res.body,/SOOP 인증 응답을 확인했습니다/);
  assert.doesNotMatch(res.body,new RegExp(authCode));
  assert.doesNotMatch(res.body,new RegExp(state));
});

test('SOOP callback handles denial without reflecting provider error details',async()=>{
  const detail='private-provider-error-detail';
  const res=createResponse();
  await handler({
    method:'GET',
    query:{operation:'soop-callback',error:'access_denied',error_description:detail},
    headers:{}
  },res);
  assert.equal(res.statusCode,400);
  assert.match(res.body,/SOOP 계정 연결이 완료되지 않았습니다/);
  assert.doesNotMatch(res.body,new RegExp(detail));
});

test('SOOP callback supports HEAD and rejects write methods',async()=>{
  const head=createResponse();
  await handler({method:'HEAD',query:{operation:'soop-callback'},headers:{}},head);
  assert.equal(head.statusCode,200);
  assert.equal(head.body,undefined);

  const post=createResponse();
  await handler({method:'POST',query:{operation:'soop-callback'},headers:{}},post);
  assert.equal(post.statusCode,405);
  assert.equal(post.headers.allow,'GET, HEAD');
});
