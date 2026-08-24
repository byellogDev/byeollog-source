import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const sourceUrl=new URL('../privacy.html',import.meta.url);

test('privacy policy publishes SOOP consent, dedicated TTS, and transfer disclosures',async()=>{
  const html=await readFile(sourceUrl,'utf8');
  for(const phrase of [
    '시행일: 2026년 8월 24일',
    '방송 여부 체크',
    '방송국 정보 조회',
    '채팅 조회·발신',
    '접근·갱신 토큰',
    '전용 TTS 서버',
    '음성 식별키',
    'Vercel Inc.',
    'Supabase 서비스 운영 법인',
    'bangsel_admin_session',
    'redacted-contact@example.invalid',
  ])assert.ok(html.includes(phrase),`missing disclosure: ${phrase}`);
});

test('privacy policy distinguishes approval-only SOOP processing',async()=>{
  const html=await readFile(sourceUrl,'utf8');
  assert.match(html,/승인 후 활성화/);
  assert.match(html,/현재 콜백 주소는 인증 결과를 받을 준비만 되어 있으며, 접근 토큰을 저장하지 않습니다/);
  assert.match(html,/본인 방송·최소 권한/);
  assert.match(html,/개인정보를 판매하지 않습니다/);
});
