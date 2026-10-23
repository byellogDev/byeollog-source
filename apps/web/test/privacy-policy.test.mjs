import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const sourceUrl=new URL('../privacy.html',import.meta.url);

test('privacy policy publishes the current wallpaper and upbo data flow',async()=>{
  const html=await readFile(sourceUrl,'utf8');
  for(const phrase of [
    '현행 설명 적용일: 2026년 10월 11일',
    '기능 관련 채팅 선별',
    '후원 이벤트',
    '외부 룰렛 결과',
    '접근·갱신 토큰',
    '로컬 배치 편집',
    '생성일로부터 최대 30일',
    '관측일로부터 최대 45일',
    'Vercel Inc.',
    'Supabase, Inc.',
    'GitHub, Inc.',
    'bangsel_admin_session',
    'redacted-contact@example.invalid',
  ])assert.ok(html.includes(phrase),`missing disclosure: ${phrase}`);
});

test('privacy policy excludes retired processing and protects ordinary chat',async()=>{
  const html=await readFile(sourceUrl,'utf8');
  assert.match(html,/일반 대화 전체를 기록하는 기능은 제공하지 않습니다/);
  assert.match(html,/후원 후 기본 2분 동안/);
  assert.match(html,/이 범위에는 일반 대화가 포함될 수 있습니다/);
  assert.match(html,/종료된 TTS 기능에서는 새로운 개인정보를 처리하지 않습니다/);
  assert.match(html,/개인정보를 판매하지 않으며/);
  assert.doesNotMatch(html,/Google Cloud Text-to-Speech|Cartesia, Inc\.|승인 후 활성화|접근 토큰을 저장하지 않습니다/);
});

test('terms describe only the current product responsibilities',async()=>{
  const html=await readFile(new URL('../terms.html',import.meta.url),'utf8');
  for(const phrase of [
    '현행 설명 적용일: 2026년 10월 11일',
    '풍벽지',
    '업보',
    '저장 결과가 없을 때 조회가 추첨 생성을 일으킬 수 있으며',
    '로컬 편집기',
    'redacted-contact@example.invalid',
  ])assert.ok(html.includes(phrase),`missing terms disclosure: ${phrase}`);
  assert.doesNotMatch(html,/공식 제공·승인한 범위에 한하지 않을 수 있습니다|검증 대상 워크스페이스/);
});
