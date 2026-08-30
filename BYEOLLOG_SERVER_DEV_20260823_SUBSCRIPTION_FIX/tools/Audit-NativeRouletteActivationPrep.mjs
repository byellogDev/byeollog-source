import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {NATIVE_ROULETTE_ASSETS} from '../lib/native-roulette-assets.js';

const root=new URL('../',import.meta.url);
const pathOf=relative=>fileURLToPath(new URL(relative,root));
const read=relative=>readFile(new URL(relative,root),'utf8');
const checks=[];
const add=(id,status,summary,evidence)=>checks.push({id,status,summary,evidence});

const ignore=await read('.vercelignore');
add('production.route.dormant',
  /^api\/native-roulette\.js$/m.test(ignore)?'pass':'fail',
  '네이티브 룰렛 Vercel 함수가 현재 운영 배포에서 제외되어야 합니다.',
  'api/native-roulette.js ignore rule');

const activeMigrations=await readdir(new URL('supabase/migrations/',root));
const dormantMigrations=await readdir(new URL('supabase/dormant-migrations/',root));
const skeleton='20260825110000_native_roulette_sdk_skeleton.sql';
add('database.migration.dormant',
  !activeMigrations.includes(skeleton)&&dormantMigrations.includes(skeleton)?'pass':'fail',
  '룰렛 런타임 SQL은 활성 migration chain 밖에 있어야 합니다.',skeleton);

const nativeSource=await read('lib/native-roulette.js');
add('runtime.trigger.v2',
  nativeSource.includes('normalizeNativeRouletteActivation')
    &&nativeSource.includes('nativeRouletteSpinPlan')
    &&nativeSource.includes('ambiguous_roulette_trigger')?'pass':'fail',
  '웹 사양의 단차·연차 발동 계약과 충돌 차단이 고정되어야 합니다.',
  'schemaVersion:2; exact trigger matching; no implicit multiplier');

const relaySource=await read('lib/soop-sdk-relay.js');
add('soop.relay.contract',
  relaySource.includes('normalizeSoopSdkRelayEnvelope')
    &&relaySource.includes('rawPayloadSha256')
    &&relaySource.includes('eventFingerprint')?'pass':'fail',
  '공식 SDK 필드 매핑 뒤 서버로 전달할 엄격한 내부 계약이 있어야 합니다.',
  'schemaVersion/provider/eventType/provider event time/receive time/reconnect telemetry');

const fixtureDir='fixtures/soop-approved-sdk';
const fixtureNames=['donation.json','chat.json','reconnect-replay.json'];
const missingFixtures=fixtureNames.filter(name=>!existsSync(pathOf(`${fixtureDir}/${name}`)));
add('soop.approved.fixtures',missingFixtures.length?'blocked':'pass',
  '승인 문서의 실제 후원·채팅·재연결 payload를 비식별 fixture로 고정해야 합니다.',
  missingFixtures.length?`missing: ${missingFixtures.join(', ')}`:'all fixtures present');

const catalogReady=NATIVE_ROULETTE_ASSETS.length===7
  &&NATIVE_ROULETTE_ASSETS.every(asset=>asset.deliveryStatus==='published'&&asset.presentationDurationMs===3000);
add('overlay.assets.published_3s',catalogReady?'pass':'blocked',
  '7개 룰렛 자산은 3초 재생본으로 immutable 게시되어야 합니다.',
  NATIVE_ROULETTE_ASSETS.map(asset=>({key:asset.key,durationMs:asset.durationMs,status:asset.deliveryStatus})));

const soundPath='dormant-native-roulette-assets/audio/roulette-spin-v1.wav';
const sound=await readFile(new URL(soundPath,root));
const soundHash=createHash('sha256').update(sound).digest('hex');
add('audio.spin.3s',sound.byteLength===576044
  &&soundHash==='651376fec5b8424825269a25e6041e591711ed1c55642fb61e20574f35382bec'?'pass':'fail',
  '선택한 3초 룰렛 효과음의 바이트와 해시가 고정되어야 합니다.',
  {bytes:sound.byteLength,sha256:soundHash});

const activationRpc=/create\s+(?:or replace\s+)?function\s+(?:public\.)?activate_native_roulette/i;
const dormantSql=await read(`supabase/dormant-migrations/${skeleton}`);
add('activation.rpc.absent',!activationRpc.test(dormantSql)?'pass':'fail',
  '운영 게이트 완료 전에는 활성화 RPC가 존재하지 않아야 합니다.',
  'fail-closed migration boundary');

const agentRoot=new URL('../../BYEOLLOG_AGENT_DEV_v07022/',root);
let agentCapability=false;
if(existsSync(agentRoot)){
  const candidates=['Byeollog.Agent/Actions/ActionTypes.cs','src/action-types.ts','src/action-types.js'];
  for(const candidate of candidates){
    const url=new URL(candidate,agentRoot);
    if(!existsSync(url))continue;
    if((await readFile(url,'utf8')).includes('native_roulette.overlay'))agentCapability=true;
  }
}
add('agent.native_roulette.overlay',agentCapability?'pass':'blocked',
  'Agent가 네이티브 룰렛 오버레이·효과음·캐시 TTS를 원자적으로 실행해야 합니다.',
  agentCapability?'capability found':'native_roulette.overlay capability not found');

const apiFiles=(await readdir(new URL('api/',root))).filter(name=>name.endsWith('.js'));
const edgeRuntimeExists=existsSync(pathOf('supabase/functions/native-roulette-runtime/index.ts'));
add('vercel.function.quota',edgeRuntimeExists&&/^api\/native-roulette\.js$/m.test(ignore)?'pass':'blocked',
  '활성화 경로는 현재 Vercel 함수 한도를 넘지 않아야 합니다.',
  {apiFunctionSources:apiFiles.length,route:'Supabase Edge native-roulette-runtime',vercelNativeApiIgnored:/^api\/native-roulette\.js$/m.test(ignore)});

const counts=checks.reduce((result,item)=>{
  result[item.status]=(result[item.status]||0)+1;return result;
},{pass:0,blocked:0,fail:0});
const report={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  activationReady:counts.blocked===0&&counts.fail===0,
  counts,
  checks
};
console.log(JSON.stringify(report,null,2));
if(counts.fail>0)process.exitCode=1;
