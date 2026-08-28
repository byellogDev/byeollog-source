import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';

const source=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const json=async path=>JSON.parse(await source(path));

function headersFor(config,path){
  return Object.fromEntries(
    (config.headers.find(rule=>rule.source===path)?.headers||[])
      .map(header=>[header.key.toLowerCase(),header.value])
  );
}

test('Collector handoff is short-lived, one-use, fragment transported, and scrubbed before exchange',async()=>{
  const [pair,loginPage,loginApi]=await Promise.all([
    source('api/collector-pair.js'),source('assets/login-page.js'),source('api/login.js')
  ]);
  assert.match(pair,/randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(pair,/now\.getTime\(\)\+45\*1000/);
  assert.match(pair,/dashboard_url:`\/login#handoff=\$\{encodeURIComponent\(code\)\}`/);
  assert.doesNotMatch(pair,/dashboard_url:`\/login\?handoff=/);

  assert.ok(loginPage.includes("new URLSearchParams(location.hash.replace(/^#/,'')"));
  assert.match(loginPage,/handoffHash\.get\('handoff'\)\|\|loginParams\.get\('handoff'\)/);
  assert.doesNotMatch(loginPage,/sessionStorage/);
  assert.ok(
    loginPage.indexOf("history.replaceState(null,'','/login')")<loginPage.indexOf("fetch('/api/login?operation=handoff'"),
    'handoff bearer must leave the address bar before exchange'
  );

  assert.match(loginApi,/\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.match(loginApi,/handoff:ip:/);
  assert.match(loginApi,/used_at=is\.null/);
  assert.match(loginApi,/prefer:'return=representation'/);
  assert.match(loginApi,/expires_at=gt\./);
});

test('public mutations reject browser cross-site origins without breaking native clients',()=>{
  const same={headers:{origin:'https://byeollog.com',host:'byeollog.com','x-forwarded-proto':'https','sec-fetch-site':'same-origin'},socket:{}};
  const preview={headers:{origin:'https://preview.example.vercel.app',host:'preview.example.vercel.app','x-forwarded-proto':'https'},socket:{}};
  const evil={headers:{origin:'https://evil.example',host:'byeollog.com','x-forwarded-proto':'https','sec-fetch-site':'cross-site'},socket:{}};
  const native={headers:{host:'byeollog.com','content-type':'application/json'},socket:{}};
  assert.equal(isTrustedMutationOrigin(same),true);
  assert.equal(isTrustedMutationOrigin(preview),true);
  assert.equal(isTrustedMutationOrigin(evil),false);
  assert.equal(isTrustedMutationOrigin({headers:{origin:'null',host:'byeollog.com'},socket:{}}),false);
  assert.equal(isTrustedMutationOrigin(native),true);
  assert.equal(isJsonRequest(native),true);
  assert.equal(isJsonRequest({headers:{'content-type':'text/plain'}}),false);
});

test('static/auth responses do not advertise wildcard CORS and auth CSP hashes every inline style',async()=>{
  const config=await json('vercel.json');
  const global=headersFor(config,'/(.*)');
  assert.equal(global['access-control-allow-origin'],'https://byeollog.com');
  assert.notEqual(global['access-control-allow-origin'],'*');
  assert.equal(global['cross-origin-resource-policy'],'same-origin');

  const pages={
    '/login':'login.html',
    '/signup':'signup.html',
    '/signup-status':'signup-status.html',
    '/reset-password':'reset-password.html',
    '/change-password':'change-password.html',
    '/withdraw':'withdraw.html'
  };
  for(const [route,file] of Object.entries(pages)){
    const html=await source(file);
    const csp=headersFor(config,route)['content-security-policy']||'';
    assert.ok(csp,`${route} CSP missing`);
    assert.doesNotMatch(csp,/'unsafe-inline'|'unsafe-eval'/,`${route} must not allow unsafe inline content`);
    assert.match(csp,/style-src-attr 'none'/);
    assert.match(csp,/script-src-attr 'none'/);
    assert.match(csp,/object-src 'none'/);
    assert.doesNotMatch(html,/\sstyle\s*=/i,`${file} has an unhashed style attribute`);
    for(const match of html.matchAll(/<style>([\s\S]*?)<\/style>/g)){
      const hash=crypto.createHash('sha256').update(match[1]).digest('base64');
      assert.ok(csp.includes(`'sha256-${hash}'`),`${route} CSP is missing its exact style hash`);
    }
  }
});

test('security.txt is RFC 9116 shaped and signup abuse controls remain layered',async()=>{
  const [security,signup]=await Promise.all([source('.well-known/security.txt'),source('lib/signup.js')]);
  assert.match(security,/^Contact: mailto:/m);
  assert.match(security,/^Canonical: https:\/\/byeollog\.com\/\.well-known\/security\.txt$/m);
  assert.match(security,/^Preferred-Languages: ko, en$/m);
  const expiry=Date.parse(security.match(/^Expires: (.+)$/m)?.[1]||'');
  assert.ok(Number.isFinite(expiry)&&expiry>Date.now(),'security.txt expiry must be in the future');

  assert.match(signup,/isTrustedMutationOrigin\(req\)/);
  assert.match(signup,/isJsonRequest\(req\)/);
  assert.match(signup,/content-length/);
  assert.match(signup,/signup:ip:/);
  assert.match(signup,/signup:email:/);
  assert.match(signup,/email\.length>254/);
  assert.match(signup,/note\.length>1000/);
});

test('authenticated dashboard style blocks are nonce-bound without changing legacy layout attributes',async()=>{
  const [admin,product,rollout]=await Promise.all([
    source('api/admin.js'),source('lib/product-dashboard-html.js'),source('lib/agent-rollout-html.js')
  ]);
  assert.match(product,/<style nonce="\$\{nonce\}">/);
  assert.match(rollout,/<style nonce="\$\{nonce\}">/);
  assert.doesNotMatch(product,/\sstyle\s*=/i);
  assert.doesNotMatch(rollout,/\sstyle\s*=/i);
  assert.match(admin,/style-src 'self' 'nonce-\$\{nonce\}'; style-src-attr 'none'/);
  assert.match(admin,/style-src-elem 'self' 'nonce-\$\{nonce\}'; style-src-attr 'unsafe-inline'/);
  assert.match(admin,/replace\(\/<style\(\\s\|>\)\/g,`<style nonce=/);
  assert.doesNotMatch(admin,/style-src 'self' 'unsafe-inline'/);
});
