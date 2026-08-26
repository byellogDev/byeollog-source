import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

async function source(relativePath){
  return readFile(new URL(relativePath,root),'utf8');
}

function inlineHashes(html,tag){
  const pattern=new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,'gi');
  return [...html.matchAll(pattern)].map(([,body])=>{
    const normalized=body.replace(/\r\n?/g,'\n');
    return `sha256-${createHash('sha256').update(normalized,'utf8').digest('base64')}`;
  });
}

test('homepage CSP strictly allows only the current inline blocks',async()=>{
  const [html,configText]=await Promise.all([
    source('index.html'),
    source('vercel.json')
  ]);
  const config=JSON.parse(configText);
  const homepageRule=config.headers.find(({source})=>source==='/');
  assert.ok(homepageRule,'homepage header rule is missing');

  const csp=homepageRule.headers.find(({key})=>key.toLowerCase()==='content-security-policy')?.value;
  assert.ok(csp,'homepage Content-Security-Policy is missing');
  for(const directive of [
    "default-src 'none'",
    "script-src-attr 'none'",
    "style-src-attr 'none'",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests'
  ]) assert.ok(csp.includes(directive),`missing CSP directive: ${directive}`);
  assert.doesNotMatch(csp,/'unsafe-inline'|'unsafe-eval'/);
  assert.doesNotMatch(html,/\son[a-z]+\s*=/i);

  const scriptHashes=inlineHashes(html,'script');
  const styleHashes=inlineHashes(html,'style');
  assert.equal(scriptHashes.length,1);
  assert.equal(styleHashes.length,1);
  for(const hash of [...scriptHashes,...styleHashes]){
    assert.ok(csp.includes(`'${hash}'`),`CSP hash is stale or missing: ${hash}`);
  }
});
