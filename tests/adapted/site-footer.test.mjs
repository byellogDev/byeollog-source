import {fileURLToPath as __sourcePath} from 'node:url';
import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = __sourcePath(new URL("../../apps/web",import.meta.url));
const copyright = '© 2026 BYEOLLOG';

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('main page omits retired feature and installer promotion copy', async () => {
  const html = await source('index.html');

  assert.doesNotMatch(html, /룰렛·액션 실행 미지원/);
  assert.doesNotMatch(html, /기존 룰렛 실행과 액션 기능은 종료되었습니다/);
  assert.doesNotMatch(html, /별록 풍벽지 설치/);
  assert.match(html, new RegExp(copyright));
});

test('long signup form uses an in-flow footer without changing other account pages',async()=>{
  const css=await source('assets/byeollog-theme.css');
  assert.match(css,/body\.auth-page\.signup-page\{[^}]*grid-template-rows:1fr auto/);
  assert.match(css,/body\.auth-page\.signup-page \.byeollogSiteFooter\{position:static;background:none\}/);
  assert.match(css,/body\.auth-page \.byeollogSiteFooter,\.byeollogSiteFooter\.footerFixed\{position:fixed/);
});

test('every user-facing web page source includes the shared copyright footer', async () => {
  const pages = [
    'index.html',
    'login.html',
    'signup.html',
    'signup-status.html',
    'reset-password.html',
    'change-password.html',
    'withdraw.html',
    'terms.html',
    'privacy.html',
    'bangsel_public_workspace_isolation.html',
    'lib/admin-source.html',
    'lib/agent-rollout-html.js',
    'lib/dashboard-navigation.js',
    'lib/soop-oauth.js',
  ];

  for (const page of pages) {
    assert.match(await source(page), new RegExp(copyright), `${page} is missing the shared copyright footer`);
  }
});
