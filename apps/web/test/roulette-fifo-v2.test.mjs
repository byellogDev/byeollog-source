import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migrationUrl=new URL('../supabase/migrations/20260914141847_normalize_audited_product_contracts.sql',import.meta.url);
const gatewayUrl=new URL('../lib/soop-gateway-api.js',import.meta.url);

function correlateFifo(expectedSpins,resultCount){
  const queue=expectedSpins.map((expected,index)=>({id:index+1,expected,count:resultCount?.[index]||0}));
  return result=>{
    const head=queue.find(job=>job.count<job.expected);
    if(!head)return null;
    head.count+=1;
    return {result,donationId:head.id,count:head.count,complete:head.count===head.expected};
  };
}

test('configured single-spin donations consume a burst strictly FIFO',()=>{
  const next=correlateFifo([1,1,1,1,1,1,1]);
  const results=['뽀뽀','2배','뽀뽀','용돈','3분','사랑해','뽀뽀'];
  assert.deepEqual(results.map(result=>next(result).donationId),[1,2,3,4,5,6,7]);
});

test('a multi-spin donation remains the FIFO head until every expected spin arrives',()=>{
  const next=correlateFifo([3,2,1]);
  const matches=Array.from({length:6},(_,index)=>next(`result-${index+1}`));
  assert.deepEqual(matches.map(match=>match.donationId),[1,1,1,2,2,3]);
  assert.deepEqual(matches.map(match=>match.complete),[false,false,true,false,true,true]);
});

test('database migration fixes the serialized FIFO and completion contracts',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.match(sql,/pg_advisory_xact_lock[\s\S]*byeollog:roulette-write:/i);
  assert.match(sql,/expected_spins is not null[\s\S]*result_count<donation\.expected_spins[\s\S]*order by donation\.occurred_at,donation\.id[\s\S]*limit 1 for update/i);
  assert.match(sql,/parsed donor hint is deliberately not allowed to skip an older configured/i);
  assert.match(sql,/v_complete:=v_expected is not null and v_count>=v_expected/i);
  assert.match(sql,/status=case when v_complete then 'complete' else 'collecting' end/i);
  assert.match(sql,/when v_count<v_expected then 'short'[\s\S]*when v_count=v_expected then 'matched'/i);
  assert.match(sql,/'sourceUid',case when v_expected is null or v_complete[\s\S]*else null end/i);
  assert.doesNotMatch(sql,/legacy_donor_name_fifo|unique_recent|sequence_continuation/);
  assert.doesNotMatch(sql,/amount::text\|\|'개 룰렛'/);
  assert.match(sql,/donation\.roulette_enabled and donation\.expected_spins is not null/);
  assert.match(sql,/not exists\(select 1 from public\.bangsel_roulette_invalidations/);
  assert.match(sql,/coalesce\(new\.roulette_enabled,false\)/);
  assert.doesNotMatch(sql,/drop function[^;]*ingest_soop_external_roulette_result_v1/i);
  assert.doesNotMatch(sql,/update public\.byeollog_soop_core_donations[^;]*set[^;]*expected_spins[^;]*from public\.byeollog_roulette_amount_mappings/i);
});

test('gateway uses activation-gated ownership-attested v4 without legacy matching',async()=>{
  const source=await readFile(gatewayUrl,'utf8');
  assert.match(source,/rpc\/ingest_soop_external_roulette_result_v4/);
  assert.doesNotMatch(source,/rpc\/ingest_soop_external_roulette_result_v2/);
  assert.doesNotMatch(source,/rpc\/ingest_soop_external_roulette_result_v1/);
  assert.match(source,/resultRow\.matched===true&&text\(resultRow\.sourceUid,220\)/);
});
