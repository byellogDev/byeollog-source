import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assessCollectorRow} from '../../apps/collector-runtime/lib/collector-processor.js';
import {ADMIN_HTML_BASE64} from '../../apps/collector-runtime/lib/admin-html.js';

function row(validation='over',result='A 단컷'){
  return {
    validation,
    event_name:'8월 이벤트',
    roulette_results:[{result,probability:''}],
    raw_payload:{type:'SENDBALLOON',subtype:'SENDBALLOON'}
  };
}

const learnedRules=new Map([
  ['A 단컷',{action:'include',output_types:['A 단컷']}],
  ['A 움짤',{action:'exclude',output_types:[]}]
]);
const noMultiplierRules=new Map();

test('automatic processing still blocks short and over count warnings',()=>{
  const assessment=assessCollectorRow(row(),learnedRules,noMultiplierRules);
  assert.equal(assessment.processable,false);
  assert.equal(assessment.reason,'validation_review');
});

test('explicit dashboard approval processes a learned count-warning result',()=>{
  const assessment=assessCollectorRow(
    row('over','A 단컷'),
    learnedRules,
    noMultiplierRules,
    {allowValidationReview:true}
  );
  assert.equal(assessment.processable,true);
  assert.equal(assessment.results.length,1);
});

test('explicit dashboard approval never bypasses an unknown classification',()=>{
  const assessment=assessCollectorRow(
    row('over','처음 보는 결과'),
    learnedRules,
    noMultiplierRules,
    {allowValidationReview:true}
  );
  assert.equal(assessment.processable,false);
  assert.equal(assessment.reason,'unknown_rule');
});

test('explicit dashboard approval never invents a missing roulette result',()=>{
  const missing={
    ...row('short'),
    roulette_results:[],
    fixed_rewards:[{event_name:'고정 후원',upbo_type:'고정 업보',quantity:1}]
  };
  const assessment=assessCollectorRow(
    missing,
    learnedRules,
    noMultiplierRules,
    {allowValidationReview:true}
  );
  assert.equal(assessment.processable,false);
  assert.equal(assessment.reason,'no_roulette_result');
});

test('only the manual bulk button sends row-version-bound validation approvals',async()=>{
  const html=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
  const api=await readFile(auditURL('../api/collector-process.js',import.meta.url),'utf8');
  const collector=await readFile(auditURL('../api/collector.js',import.meta.url),'utf8');
  assert.match(html,/processCollectorInbox[\s\S]*validation_review_approvals/);
  assert.match(html,/개수 확인이 필요한 \$\{warningCount\}건/);
  assert.match(html,/const selectedRows=collectorRows\.slice\(0,1000\)/);
  assert.match(html,/selectedRows\.slice\(i,i\+500\)/);
  assert.match(html,/uploaded_at:String\(row\.uploaded_at\|\|''\)/);
  assert.match(api,/validationReviewApprovals\.set\(uid,uploadedAt\)/);
  assert.match(api,/sourceUids\?\.includes\(uid\)/);
  assert.match(api,/validationReviewApprovals/);
  assert.doesNotMatch(collector,/validationReviewApprovals|validation_review_approvals/);
  assert.match(html,/처리 완료 \$\{c\.processed\|\|0\}건 · 생성 업보 \$\{c\.tasks\|\|0\}개/);
  const processor=await readFile(auditURL('../lib/collector-processor.js',import.meta.url),'utf8');
  const claimAt=processor.indexOf('const claimed=await claimRow');
  const reassessAt=processor.indexOf('assessCollectorRow(claimed',claimAt);
  assert.ok(claimAt>=0&&reassessAt>claimAt,'claimed current row must be reassessed after the claim');
  assert.match(processor,/String\(claimed\.uploaded_at\|\|''\)===approvedUploadedAt/);
  assert.match(processor,/expectedUploadedAt:uploadedAt,[\s\S]*requireProcessing:true/);
  assert.match(processor,/row_changed_during_processing/);
  assert.match(processor,/uploaded_at=eq\.\$\{q\(claimed\.uploaded_at\)\}&process_status=eq\.processing/);
});

test('normal users are not shown the destructive Collector test-data cleanup control',()=>{
  const html=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
  assert.doesNotMatch(html,/TEST 데이터 전체 삭제/);
  assert.doesNotMatch(html,/deleteAllCollectorTestData|deleteTestDataBtn/);
});
