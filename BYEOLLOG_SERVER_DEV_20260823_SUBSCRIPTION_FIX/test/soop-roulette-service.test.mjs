import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  claimOverlayTtsSynthesis,
  claimRouletteOverlayCommand,
  createOverlayTtsAuthorization,
  createRouletteServiceOverlayToken,
  finishOverlayTtsSynthesis,
  finishRouletteOverlayCommand,
  getRouletteServiceOverlayHtml,
  overlayTtsText,
  peekRouletteOverlayFollowup,
  recordRouletteChatDryRun,
  ROULETTE_OVERLAY_CLIENT_VERSION,
  rouletteOverlayUrl,
  touchRouletteOverlayClient,
  verifyOverlayTtsAuthorization,
  verifyRouletteServiceOverlayToken
} from '../lib/soop-roulette-service.js';
import {
  COMMON_OVERLAY_MAX_DISPLAY_NAME_GRAPHEMES,
  COMMON_OVERLAY_V8_LAYOUT,
  computeCommonOverlayScale
} from '../lib/common-overlay-v8.js';

const workspaceId='a401d02e-b75e-4414-a9bb-6bb1230682d8';
const tokenVersion='f4cb73b4-54d3-46f3-97d4-bf32210e5719';
const env={SOOP_GATEWAY_INGRESS_SECRET:'s'.repeat(64),SUPABASE_URL:'https://example.supabase.co'};

test('production overlay token is stable, workspace-bound, revocable, and tamper evident',()=>{
  const token=createRouletteServiceOverlayToken(workspaceId,tokenVersion,{env,nonce:'fixed-nonce'});
  const payload=verifyRouletteServiceOverlayToken(token,{env});
  assert.deepEqual([payload?.wid,payload?.tv],[workspaceId,tokenVersion]);
  assert.equal(verifyRouletteServiceOverlayToken(token+'x',{env}),null);
});

test('managed TTS authorization binds workspace, command, client, attempt and exact text',()=>{
  const commandId='8d66048f-d838-4efc-b2b1-6123d37c3468',clientId='overlay-client-1',text='아봉 10초';
  const authorization=createOverlayTtsAuthorization(workspaceId,clientId,commandId,2,text,{env,now:()=>1_000_000,ttlSeconds:120});
  const payload=verifyOverlayTtsAuthorization(authorization,text,{env,now:()=>1_030_000});
  assert.deepEqual([payload?.wid,payload?.cid,payload?.oid,payload?.attempt],[workspaceId,clientId,commandId,2]);
  assert.equal(verifyOverlayTtsAuthorization(authorization,'다른 문장',{env,now:()=>1_030_000}),null);
  assert.equal(verifyOverlayTtsAuthorization(authorization,text,{env,now:()=>1_130_000}),null);
  assert.equal(overlayTtsText('roulette_spin',{resultText:'아봉 10초',ttsText:'예전 저장값, 당첨!'}),'아봉 10초');
  const twenty='가나다라마바사아자차카타파하거너더러머버';
  assert.equal(overlayTtsText('roulette_spin',{resultText:twenty+'보'}),twenty);
  assert.equal(overlayTtsText('donation_ceremony',{actor:{name:'도전자'},donationTypeLabel:'도전미션',amount:330}),'도전자님 도전미션 330개 감사합니다!');
  assert.equal(overlayTtsText('donation_chat_tts',{displayText:'[10초 전] 채팅',ttsText:'채팅'}),'채팅');
});

test('overlay claim validates live token version and expands a verified custom image URL',async()=>{
  const calls=[];
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    if(table==='rpc/claim_native_roulette_overlay_v5')return [{command_id:'8d66048f-d838-4efc-b2b1-6123d37c3468',command_kind:'roulette_spin',payload:{resultText:'아봉 10초',ttsText:'아봉 10초, 당첨!',customImage:{storagePath:`workspaces/${workspaceId}/single/6389000e-9d2c-4ac6-ac9b-7f7a41801dd4.webp`}},attempt_count:1,lease_expires_at:'2026-08-29T04:00:00.000Z',event_id:'514ff4e5-dcc3-4541-887c-f9b18eecaf59',event_occurred_at:'2026-08-29T03:59:55.000Z',activation_snapshot:{items:[{resultText:'아봉 10초'}],followupChatTtsWindowSeconds:10}}];
    throw new Error('unexpected '+table);
  };
  const preferredEventId='514ff4e5-dcc3-4541-887c-f9b18eecaf59';
  const result=await claimRouletteOverlayCommand({wid:workspaceId,tv:tokenVersion},'client-1',{sbImpl,env,preferredEventId});
  assert.equal(result.invalid,false);
  assert.equal(result.clientVersion,ROULETTE_OVERLAY_CLIENT_VERSION);
  assert.match(result.command.payload.customImage.previewUrl,/\/storage\/v1\/object\/public\/byeollog-roulette-assets\/workspaces\//);
  assert.deepEqual(result.command.payload.rouletteItems,['아봉 10초']);
  assert.equal(result.command.payload.eventId,'514ff4e5-dcc3-4541-887c-f9b18eecaf59');
  assert.equal(result.command.payload.eventOccurredAt,'2026-08-29T03:59:55.000Z');
  assert.equal(result.command.payload.followupChatTtsWindowSeconds,30);
  assert.equal(result.command.payload.ttsText,'아봉 10초');
  assert.match(result.command.ttsAuthorization,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal('layout' in result,false);
  assert.equal('preview' in result,false);
  assert.equal(calls[0].table,'rpc/claim_native_roulette_overlay_v5');
  assert.equal(calls[0].options.body.p_token_version,tokenVersion);
  assert.equal(calls[0].options.body.p_preferred_event_id,preferredEventId);
  assert.equal(calls[0].options.body.p_lease_seconds,180);
});

test('ceremony claim keeps the donation card alive for its tracked message window',async()=>{
  const eventId='514ff4e5-dcc3-4541-887c-f9b18eecaf59';
  const sbImpl=async table=>{
    if(table==='rpc/claim_native_roulette_overlay_v5')return [{
      command_id:'8d66048f-d838-4efc-b2b1-6123d37c3468',command_kind:'donation_ceremony',
      payload:{actor:{name:'도전자'},amount:330,donationTypeLabel:'도전미션',ceremony:{source:'soop',url:'https://static.file.sooplive.com/balloon/challenge.png'}},
      attempt_count:1,lease_expires_at:'2026-08-29T04:00:00.000Z',event_id:eventId,
      event_occurred_at:'2026-08-29T03:59:55.000Z',activation_snapshot:{followupChatTtsWindowSeconds:10}
    }];
    throw new Error('unexpected '+table);
  };
  const result=await claimRouletteOverlayCommand({wid:workspaceId,tv:tokenVersion},'client-1',{sbImpl,env});
  assert.equal(result.command.kind,'donation_ceremony');
  assert.equal(result.command.payload.donationTypeLabel,'도전미션');
  assert.equal(result.command.payload.followupChatTtsWindowSeconds,30);
  assert.equal(result.command.payload.eventId,eventId);
  assert.equal(result.command.payload.ceremony.defaultFallbackUrl,'https://res.sooplive.com/new_player/items/ba_step4.png');
  assert.equal(result.command.payload.ttsText,'도전자님 도전미션 330개 감사합니다!');
  assert.match(result.command.ttsAuthorization,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('follow-up peek is display-only and returns a bounded event-scoped payload',async()=>{
  const calls=[];
  const eventId='514ff4e5-dcc3-4541-887c-f9b18eecaf59';
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    if(table==='rpc/peek_native_roulette_followup_v1')return [{command_id:'8d66048f-d838-4efc-b2b1-6123d37c3468',event_id:eventId,message:'눈치챙겨',source_kind:'followup_chat',captured_at:'2026-08-29T04:00:01.000Z'}];
    throw new Error('unexpected '+table);
  };
  const result=await peekRouletteOverlayFollowup({wid:workspaceId,tv:tokenVersion},'overlay-client-1',eventId,{sbImpl});
  assert.deepEqual(result.peek,{commandId:'8d66048f-d838-4efc-b2b1-6123d37c3468',eventId,message:'눈치챙겨',sourceKind:'followup_chat',capturedAt:'2026-08-29T04:00:01.000Z'});
  assert.equal(calls[0].table,'rpc/peek_native_roulette_followup_v1');
  assert.deepEqual(calls[0].options.body,{p_workspace_id:workspaceId,p_token_version:tokenVersion,p_client_id:'overlay-client-1',p_event_id:eventId});
});

test('managed TTS and overlay heartbeat use service-only RPC boundaries',async()=>{
  const calls=[];
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    if(table==='rpc/claim_native_roulette_tts_v1')return [{request_id:'9053a3a4-e853-4034-9f59-59db084b17e1',allowed:true}];
    if(table==='rpc/finish_native_roulette_tts_v1')return true;
    if(table==='rpc/touch_native_roulette_overlay_client_v2')return true;
    throw new Error('unexpected '+table);
  };
  const tts={wid:workspaceId,oid:'8d66048f-d838-4efc-b2b1-6123d37c3468',cid:'overlay-client-1',attempt:1,th:'a'.repeat(64)};
  assert.equal((await claimOverlayTtsSynthesis(tts,{sbImpl})).allowed,true);
  assert.equal(await finishOverlayTtsSynthesis(tts,'9053a3a4-e853-4034-9f59-59db084b17e1',{succeeded:true,provider:'google',firstAudioMs:200,totalMs:900,audioBytes:48000},{sbImpl}),true);
  assert.equal((await touchRouletteOverlayClient({wid:workspaceId,tv:tokenVersion},'overlay-client-1',{sbImpl})).touched,true);
  assert.deepEqual(calls.map(call=>call.table),['rpc/claim_native_roulette_tts_v1','rpc/finish_native_roulette_tts_v1','rpc/touch_native_roulette_overlay_client_v2']);
});

test('overlay acknowledgement is tied to workspace, command and lease owner',async()=>{
  const calls=[];
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    return {status:'succeeded'};
  };
  const commandId='8d66048f-d838-4efc-b2b1-6123d37c3468';
  const result=await finishRouletteOverlayCommand({wid:workspaceId,tv:tokenVersion},'client-1',commandId,true,null,{sbImpl});
  assert.equal(result.invalid,false);
  assert.equal(calls[0].table,'rpc/finish_native_roulette_overlay_v4');
  assert.deepEqual(calls[0].options.body,{p_workspace_id:workspaceId,p_token_version:tokenVersion,p_command_id:commandId,p_client_id:'client-1',p_succeeded:true,p_error:null});
});

test('roulette result reveal records a dry-run chat command through the service-only RPC',async()=>{
  const calls=[];
  const commandId='8d66048f-d838-4efc-b2b1-6123d37c3468';
  const sbImpl=async(table,path,options)=>{
    calls.push({table,path,options});
    return {status:'recorded',message:'룰렛 결과 : 아봉 10초'};
  };
  const result=await recordRouletteChatDryRun(
    {wid:workspaceId,tv:tokenVersion},'overlay-client-1',commandId,{sbImpl});
  assert.equal(result.invalid,false);
  assert.equal(result.result.message,'룰렛 결과 : 아봉 10초');
  assert.equal(calls[0].table,'rpc/record_native_roulette_chat_dry_run_v1');
  assert.deepEqual(calls[0].options.body,{
    p_workspace_id:workspaceId,p_token_version:tokenVersion,
    p_command_id:commandId,p_client_id:'overlay-client-1'
  });
});

test('production common overlay keeps a series card alive and reads its tracked message last',()=>{
  const html=getRouletteServiceOverlayHtml('nonce');
  const scripts=[...html.matchAll(/<script nonce="nonce">([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  assert.equal(scripts.length,1);
  for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
  assert.match(html,/width:460px;height:450px/);
  assert.match(html,/width:420px/);
  assert.match(html,/\.artShell\{[^}]*width:420px;min-height:166px;flex:1/);
  assert.match(html,/resultPanel\{[\s\S]*height:100px/);
  assert.match(html,/@font-face\{font-family:"Freesentation"/);
  assert.match(html,/--gold:#ffc247/);
  assert.match(html,/text-shadow:var\(--alert-outline\)/);
  assert.doesNotMatch(html,/\.resultPanel\{[^}]*border:/);
  assert.doesNotMatch(html,/\.ceremonyPanel\{[^}]*border:/);
  assert.match(html,/await sleep\(3000\)/);
  assert.match(html,/donation_chat_tts/);
  assert.match(html,/payload\.ttsText\|\|payload\.message/);
  assert.match(html,/\/api\/auth\/soop\/roulette-overlay\/tts/);
  assert.match(html,/command\.ttsAuthorization/);
  assert.match(html,/createBuffer\(1,samples,24000\)/);
  assert.match(html,/setInterval\(heartbeat,5000\)/);
  assert.match(html,/heartbeat:true/);
  assert.match(html,/claimedOnce=true/);
  assert.match(html,/if\(!token\|\|stopped\|\|!claimedOnce\)return/);
  assert.doesNotMatch(html,/heartbeat\(\);poll\(\)/);
  assert.match(html,/if\(streamed\)\{console\.warn\([^)]*partial audio[^)]*\);return\}/);
  assert.match(html,/function resetSpinSound\(\)/);
  assert.match(html,/await sleep\(3000\);resetSpinSound\(\)/);
  assert.match(html,/FOLLOWUP_WINDOW_MS=30000/);
  assert.match(html,/if\(position\.current<position\.total\)\{scheduleCloseAfter\(FOLLOWUP_WINDOW_MS\)/);
  assert.match(html,/const landingMs=setWinner\(payload\.resultText/);
  assert.match(html,/await sleep\(landingMs\);void reportResultReveal\(command\);await speak/);
  assert.match(html,/action:'result-revealed',commandId:command\.id/);
  assert.doesNotMatch(html,/await reportResultReveal\(command\)/);
  const dryRunReporter=html.match(/async function reportResultReveal\(command\)\{[^\n]+/i)?.[0]||'';
  assert.doesNotMatch(dryRunReporter,/stopped=true/);
  assert.match(html,/loadImage\(image,data\.url,'ceremony'\)/);
  assert.match(html,/id="ceremonyPanel" class="ceremonyPanel"/);
  assert.match(html,/id="ceremonyDonorName"/);
  assert.match(html,/id="ceremonyDonationSummary"/);
  assert.match(html,/id="ceremonyMessageArea"/);
  assert.match(html,/id="ceremonyMessageText"/);
  assert.match(html,/\.ceremonyImageWrap\{[^}]*width:420px;min-height:210px;flex:1/);
  assert.match(html,/function showCeremonyMessage\(text\)/);
  assert.match(html,/belongsToCeremony=ceremonyVisible&&activeCeremonyEventId&&activeCeremonyEventId===eventId/);
  assert.match(html,/if\(belongsToCeremony\)\{clearCeremonyCloseTimer\(\);showCeremonyMessage\(payload\.message\|\|payload\.ttsText\|\|''\);await speak/);
  assert.match(html,/preferredEventId=cardVisible&&activeEventId\?activeEventId:ceremonyVisible&&activeCeremonyEventId\?activeCeremonyEventId:null/);
  assert.match(html,/async function ceremony\(command\)[\s\S]*await speak\(command,payload\.ttsText\|\|''/);
  assert.match(html,/ALERT_MIN_DISPLAY_MS=5000/);
  assert.match(html,/trackedEventId=cardVisible&&activeEventId\?activeEventId:ceremonyVisible&&activeCeremonyEventId\?activeCeremonyEventId:null/);
  assert.match(html,/showCeremonyMessage\(peek\.message\);scheduleCeremonyCloseAfter\(FOLLOWUP_WINDOW_MS\)/);
  assert.match(html,/ceremonyDonationSummary'\)\.textContent=type\+' '\+amount\.toLocaleString\(\)\+'개'/);
  assert.match(html,/byeollogPlayedOverlayCommands/);
  assert.match(html,/function remember\(id\)[\s\S]*slice\(-4096\)/);
  assert.match(html,/if\(wasPlayed\(data\.command\.id\)\)await ack\(data\.command\.id,true\)/);
  assert.match(html,/for\(let attempt=0;attempt<5;attempt\+\+\)/);
  assert.doesNotMatch(html,/sessionStorage\.setItem\([^)]*(?:message|ttsText|resultText)/);
  assert.match(html,/fallbackSpeak/);
  assert.match(html,/X-Byeollog-Overlay-Client/);
  assert.match(html,/byeollogOverlayToken/);
  assert.match(html,/response\.status===423/);
  assert.match(html,/remember\(command\.id\);succeeded=true/);
  assert.match(html,/await ack\(command\.id,succeeded,failure\)/);
  assert.match(html,/id="rouletteGroup"/);
  assert.match(html,/id="rouletteCard" class="rouletteCard"[\s\S]*class="artShell"[\s\S]*id="resultPanel"/);
  assert.match(html,/id="resultPanel"/);
  assert.doesNotMatch(html,/function applyLayouts|applyPart\(/);
  assert.match(html,/position:fixed;inset:0/);
  assert.match(html,/command\.kind==='donation_ceremony'/);
  assert.match(html,/id="ceremonyImage"/);
  assert.match(html,/id="ceremonyCard" class="ceremonyCard"/);
  assert.match(html,/id="ceremonyFallbackCount"/);
  assert.match(html,/loadImage\(image,data\.defaultFallbackUrl,'SOOP default'\)/);
  assert.match(html,/classList\.toggle\('imageUnavailable',!loaded\)/);
  assert.match(html,/if\(abandonedEventIds\.has\(eventId\)\)return/);
  assert.doesNotMatch(html,/occurredAt\+16200|finalCloseDelay/);
  assert.doesNotMatch(html,/async function ceremony\(command\)\{[^}]*if\(!data\.url\)return/);
  assert.doesNotMatch(html,/soop-default-balloon/);
  assert.match(html,/providerFallbackUrl/);
  assert.doesNotMatch(html,/\.rouletteCard\{width:min\(92vw,960px\)/);
  assert.doesNotMatch(html,/function fitRouletteCard\(\)/);
  assert.doesNotMatch(html,/image\.naturalWidth\/image\.naturalHeight/);
  assert.match(html,/function applyStageScale\(\)/);
  assert.match(html,/data\.clientVersion&&data\.clientVersion!==clientVersion/);
  assert.doesNotMatch(html,/applyPart\('resultPanel'/);
  assert.doesNotMatch(html,/rouletteCard\.builtin \.resultPanel\{position:absolute/);
  assert.match(html,/\.resultPanel\.spinning\{height:42px\}/);
  assert.doesNotMatch(html,/roulette\(command\)[^\n]*startSlot\(/);
  assert.match(html,/setWinner\(payload\.resultText/);
  assert.match(html,/await speak\(command,payload\.resultText\|\|''/);
  assert.doesNotMatch(html,/payload\.resultText\|\|''\)\+', 당첨!'/);
  assert.match(html,/id="donorName"/);
  assert.match(html,/id="donationSummary"/);
  assert.match(html,/donationTypeLabel\|\|payload\.balloonTypeLabel\|\|'별풍선'/);
  assert.match(html,/id="seriesCounter"/);
  assert.match(html,/id="messageArea"/);
  assert.match(html,/seriesPosition\(payload\)/);
  assert.match(html,/position\.current<position\.total/);
  assert.match(html,/belongsToCard=cardVisible&&activeEventId&&activeEventId===eventId/);
  assert.match(html,/setInterval\(peekFollowup,450\)/);
  assert.match(html,/X-Byeollog-Overlay-Preferred-Event/);
  assert.match(html,/body:JSON\.stringify\(\{action:'peek',eventId:trackedEventId\}\)/);
  assert.match(html,/showMessage\(peek\.message\)/);
  assert.match(html,/showMessage\(payload\.message\|\|payload\.ttsText\|\|''\)/);
  assert.match(html,/await speak\(command,payload\.ttsText\|\|payload\.message\|\|''/);
  assert.match(html,/@keyframes glyphLand/);
  assert.match(html,/@keyframes counterFlip/);
  assert.match(html,/@keyframes messageReveal/);
  assert.match(html,/MAX_DISPLAY_NAME_GRAPHEMES=120,MAX_RESULT_NAME_GRAPHEMES=20/);
  assert.match(html,/function displayName\(value\)[\s\S]*\.slice\(0,MAX_DISPLAY_NAME_GRAPHEMES\)\.join\(''\)/);
  assert.doesNotMatch(html,/text-overflow:ellipsis[^}]*donorName|donorName[^}]*text-overflow:ellipsis/);
  assert.match(html,/function fitMetaLine\(lineId\)/);
  assert.match(html,/function limitResultName\(value\)[\s\S]*slice\(0,MAX_RESULT_NAME_GRAPHEMES\)/);
  assert.match(html,/fitTextClass\(slot,value,9,12\)/);
  assert.match(html,/\.slotValue\.medium\{font-size:32px\}\.slotValue\.long\{font-size:27px/);
  assert.match(html,/\.resultPanel\.hasMessage \.slotValue\.long\{font-size:24px/);
  assert.match(html,/\.seriesCounter\.hidden\{display:none\}/);
  assert.match(html,/position\.total>1\|\|budget>20/);
  assert.match(html,/counter\.textContent='\['\+position\.current\+'\]'/);
  assert.match(html,/if\(length<=22\)return 32/);
  assert.match(html,/panel\.style\.height=\(100\+height\)\+'px'/);
  assert.match(html,/function standaloneChatText\(payload\)[\s\S]*displayName\(payload\.actor&&payload\.actor\.name\)/);
  assert.match(html,/presentationMemory=new Map\(\)/);
  assert.match(html,/remembered\?\.kind==='roulette_spin'/);
  assert.match(html,/remembered\?\.kind==='donation_ceremony'/);
  assert.match(html,/@keyframes alertFadeIn/);
  assert.match(html,/@keyframes alertFadeOut/);
  assert.match(html,/@keyframes textTada/);
  assert.match(html,/object-fit:contain/);
  assert.doesNotMatch(html,/style\.opacity='\.82'/);
  assert.doesNotMatch(html,/text-overflow:ellipsis;white-space:nowrap[^}]*slotValue/);
  assert.match(html,/\.ready\{display:none!important\}/);
  assert.match(html,/id="ready" class="ready" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(html,/>별록 공통 오버레이 연결 중<|>별록 공통 오버레이 연결됨</);
  assert.doesNotMatch(html,/function previewPart\(/);
  assert.doesNotMatch(html,/실험|4시간|roulette-public-asset/);
});

test('chatbot dry-run migration is reveal-gated, idempotent and cannot send live chat',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260902123052_add_roulette_chat_dry_run_reveal_outbox.sql',import.meta.url),'utf8');
  assert.match(sql,/create table byeollog_automation\.native_roulette_chat_dry_runs_v1/i);
  assert.match(sql,/delivery_mode text not null default 'dry_run'/i);
  assert.match(sql,/unique\(spin_id\)/i);
  assert.match(sql,/command\.command_kind='roulette_spin'/i);
  assert.match(sql,/command\.status not in \('processing','succeeded'\)/i);
  assert.match(sql,/processed_at is null[\s\S]*processed_at<clock_timestamp\(\)-interval '5 minutes'/i);
  assert.match(sql,/v_message:='룰렛 결과 : '\|\|btrim\(v_spin\.result_text\)/i);
  assert.match(sql,/on conflict\(spin_id\) do nothing/i);
  assert.match(sql,/grant execute on function public\.record_native_roulette_chat_dry_run_v1[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/sendMessage|sendManagerMessage/i);
});

test('v8 uses the maximum rendered card envelope as a stable OBS source boundary',()=>{
  const html=getRouletteServiceOverlayHtml('nonce');
  assert.equal(COMMON_OVERLAY_MAX_DISPLAY_NAME_GRAPHEMES,120);
  assert.deepEqual(COMMON_OVERLAY_V8_LAYOUT,{logicalWidth:460,logicalHeight:450,cardWidth:420,artWidth:420,artHeight:166,cardTop:15,basePanelHeight:100,maxMessageHeight:154,maxDisplayNameGraphemes:120,maxResultNameGraphemes:20});
  assert.equal(computeCommonOverlayScale(460,450),1);
  assert.equal(computeCommonOverlayScale(920,900),2);
  assert.equal(computeCommonOverlayScale(1920,1080),1080/450);
  assert.equal(computeCommonOverlayScale(230,225),0.5);
  const maximumCardHeight=COMMON_OVERLAY_V8_LAYOUT.artHeight+COMMON_OVERLAY_V8_LAYOUT.basePanelHeight+COMMON_OVERLAY_V8_LAYOUT.maxMessageHeight;
  assert.equal(maximumCardHeight,420);
  assert.equal(COMMON_OVERLAY_V8_LAYOUT.cardTop+maximumCardHeight,435);
  assert.equal((COMMON_OVERLAY_V8_LAYOUT.logicalWidth-COMMON_OVERLAY_V8_LAYOUT.cardWidth)/2,20);
  assert.equal(COMMON_OVERLAY_V8_LAYOUT.logicalHeight-(COMMON_OVERLAY_V8_LAYOUT.cardTop+maximumCardHeight),15);
  assert.match(html,/logicalStage\{[^}]*overflow:hidden/);
  assert.match(html,/rouletteGroup\{[^}]*top:15px/);
  assert.doesNotMatch(html,/innerWidth\/1920|innerHeight\/1080/);
});

test('overlay page still renders when an optional asset origin is unavailable',async()=>{
  const source=await readFile(new URL('../api/login.js',import.meta.url),'utf8');
  assert.match(source,/let assetOrigin='';\s*try\{assetOrigin=rouletteAssetOrigin\(\)\}catch\{\}/);
  assert.match(source,/const assetSource=assetOrigin\?` \$\{assetOrigin\}`:''/);
  assert.match(source,/img-src 'self' data:\$\{assetSource\}/);
  assert.match(source,/font-src https:\/\/fastly\.jsdelivr\.net/);
  assert.match(getRouletteServiceOverlayHtml('nonce'),/rel="preload"[^>]+Freesentation-7Bold\.woff2[^>]+as="font"/);
});

test('managed TTS migration stores metadata only and blocks browser execution',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829173255_add_managed_overlay_tts_runtime.sql',import.meta.url),'utf8');
  assert.match(sql,/native_roulette_tts_attempts_v1/i);
  assert.match(sql,/stores no message text or audio/i);
  assert.doesNotMatch(sql,/^\s*(?:message|text|audio)\s+(?:text|bytea)\b/im);
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/claim_native_roulette_tts_v1/i);
  assert.match(sql,/finish_native_roulette_tts_v1/i);
  assert.match(sql,/touch_native_roulette_overlay_client_v1/i);
  assert.match(sql,/extensions\.digest\(pg_catalog\.convert_to\(v_expected_text,'UTF8'\),'sha256'\)/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,220}to anon|grant execute[\s\S]{0,220}to authenticated/i);
});

test('Google TTS promotion keeps provider metadata service-only and preserves historical rows',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260830012515_promote_google_tts_primary.sql',import.meta.url),'utf8');
  assert.match(sql,/provider in \('google','cartesia','inworld'\)/i);
  assert.match(sql,/p_provider not in \('google','cartesia','inworld'\)/i);
  assert.match(sql,/security definer/i);
  assert.match(sql,/set search_path=''/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,220}to anon|grant execute[\s\S]{0,220}to authenticated/i);
});

test('roulette result TTS normalization migration authorizes only the exact product name',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829190227_normalize_roulette_result_tts_text.sql',import.meta.url),'utf8');
  assert.match(sql,/when 'roulette_spin' then nullif\(btrim\(v_command\.payload->>'resultText'\),''\)/i);
  assert.doesNotMatch(sql,/when 'roulette_spin'[^\n]*payload->>'ttsText'/i);
  assert.doesNotMatch(sql,/당첨!/);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
});

test('Weflab baseline migration extends donor chat capture and safely authorizes donation-summary TTS',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260903032716_weflab_overlay_baseline.sql',import.meta.url),'utf8');
  assert.match(sql,/\{followupChatTtsWindowSeconds\}','30'::jsonb/i);
  assert.match(sql,/expires_at=wait\.opens_at\+interval '30 seconds'/i);
  assert.match(sql,/command\.command_kind in \('roulette_spin','donation_chat_tts','donation_ceremony'\)/i);
  assert.match(sql,/when 'donation_ceremony' then[\s\S]*v_actor_name\|\|'님 '/i);
  assert.match(sql,/p_text_sha256!~'\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql,/v_expected_hash<>p_text_sha256/i);
  assert.match(sql,/grant execute on function public\.claim_native_roulette_tts_v1[\s\S]*to service_role/i);
});

test('overlay URLs are client-versioned so a copied OBS source receives current rendering code',()=>{
  const url=rouletteOverlayUrl('token-value');
  assert.match(url,new RegExp(`\\?v=${ROULETTE_OVERLAY_CLIENT_VERSION}`));
  assert.match(url,/#token=token-value$/);
});

test('series overlay claim returns a stable event identity without exposing it to browser roles',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829193604_add_live_roulette_followup_card.sql',import.meta.url),'utf8');
  assert.match(sql,/claim_native_roulette_overlay_v3/i);
  assert.match(sql,/event_id uuid[\s\S]*event_occurred_at timestamptz/i);
  assert.match(sql,/join byeollog_automation\.native_roulette_events_v2 event/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,220}to anon|grant execute[\s\S]{0,220}to authenticated/i);
});

test('donor follow-up remains eligible until the roulette series and final card finish',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829200648_keep_followup_chat_open_during_series.sql',import.meta.url),'utf8');
  assert.match(sql,/create or replace function public\.ingest_native_roulette_soop_chat_v2/i);
  assert.match(sql,/outbox\.command_kind='roulette_spin'/i);
  assert.match(sql,/outbox\.status in \('pending','processing'\)/i);
  assert.match(sql,/outbox\.processed_at>=p_occurred_at-interval '3 seconds'/i);
  assert.match(sql,/p_occurred_at<=wait\.expires_at\s+or exists/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
});

test('v8 delivery keeps one donation contiguous and peeks text without consuming TTS',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829203650_rebuild_common_overlay_delivery_v8.sql',import.meta.url),'utf8');
  assert.match(sql,/claim_native_roulette_overlay_v4/i);
  assert.match(sql,/p_preferred_event_id uuid default null/i);
  assert.match(sql,/outbox\.event_id=p_preferred_event_id/i);
  assert.match(sql,/status='processing'[\s\S]*client_id=btrim\(p_client_id\)[\s\S]*lease_expires_at>clock_timestamp\(\)/i);
  assert.match(sql,/renewed as \([\s\S]*lease_expires_at=[\s\S]*returning outbox\.\*/i);
  assert.doesNotMatch(sql,/renewed as \([\s\S]{0,500}attempt_count=outbox\.attempt_count\+1/i);
  assert.match(sql,/peek_native_roulette_followup_v1/i);
  assert.match(sql,/command_kind='donation_chat_tts'[\s\S]*status in \('pending','processing'\)/i);
  assert.match(sql,/finish_native_roulette_overlay_v4/i);
  assert.match(sql,/v_command\.status='succeeded'[\s\S]*'idempotent',true/i);
  assert.match(sql,/interval '6 hours'/i);
  assert.match(sql,/presentationIndex/i);
  assert.match(sql,/presentationCount/i);
  assert.match(sql,/touch_native_roulette_overlay_client_v2/i);
  assert.match(sql,/get diagnostics v_inserted=row_count/i);
  assert.match(sql,/'duplicate',v_inserted=0/i);
  assert.match(sql,/last_error='overlay retry limit exhausted'/i);
  assert.match(sql,/native_roulette_overlay_outbox_v2_processing_client_idx/i);
  assert.match(sql,/set search_path=''/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,220}to anon|grant execute[\s\S]{0,220}to authenticated/i);
});

test('overlay HTTP contract separates preferred claims, display peeks, and acknowledgements',async()=>{
  const source=await readFile(new URL('../api/login.js',import.meta.url),'utf8');
  assert.match(source,/x-byeollog-overlay-preferred-event/i);
  assert.match(source,/preferredEventId:preferredHeader\|\|null/i);
  assert.match(source,/body\.action==='peek'/i);
  assert.match(source,/peekRouletteOverlayFollowup\(payload,clientId,eventId\)/i);
  assert.match(source,/body\.action&&body\.action!=='ack'/i);
  assert.match(source,/body\.action==='heartbeat'\|\|body\.heartbeat===true/i);
});

test('legacy overlay layout storage remains private but is no longer consumed by the common overlay',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260828231500_add_native_roulette_overlay_layout.sql',import.meta.url),'utf8');
  const resultPartSql=await readFile(new URL('../supabase/migrations/20260828234000_add_roulette_result_overlay_part.sql',import.meta.url),'utf8');
  assert.match(sql,/overlay_layouts jsonb/i);
  assert.match(sql,/update_overlay_part_layout_v1/i);
  assert.match(sql,/request_overlay_part_preview_v1/i);
  assert.match(sql,/p_part_key!~'\^\[a-z\]/i);
  assert.match(sql,/p_scale_percent not between 25 and 200/i);
  assert.match(sql,/expiresAt[\s\S]*interval '60 seconds'/i);
  assert.match(sql,/grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,180}to anon|grant execute[\s\S]{0,180}to authenticated/i);
  assert.match(resultPartSql,/roulette_result/i);
  assert.match(resultPartSql,/p_scale_percent not between 0 and 200/i);
  assert.match(resultPartSql,/p_part_key not in \('roulette','roulette_result'\)/i);
  const service=await readFile(new URL('../lib/soop-roulette-service.js',import.meta.url),'utf8');
  assert.doesNotMatch(service,/overlay_layouts|overlay_preview_request|update_overlay_part_layout/);
});

test('one active OBS consumer owns the workspace and a stale client can recover',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260828223200_lock_native_roulette_overlay_client.sql',import.meta.url),'utf8');
  assert.match(sql,/overlay_client_id/i);
  assert.match(sql,/interval '15 seconds'/i);
  assert.match(sql,/overlay client is already active[\s\S]*55P03/i);
  assert.match(sql,/for update skip locked/i);
});

test('production migration provides exactly-once ingest and restart-safe overlay leasing',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260828213853_promote_native_roulette_production_runtime.sql',import.meta.url),'utf8');
  assert.match(sql,/unique\(workspace_id,provider_event_id\)/i);
  assert.match(sql,/native_roulette_overlay_outbox_v2/i);
  assert.match(sql,/for update skip locked/i);
  assert.match(sql,/native_roulette_sample_ppm_v1\(\)/i);
  assert.match(sql,/source_event_key='soop-native:'/i);
  assert.match(sql,/playAfterDonationResults/i);
  assert.match(sql,/ttsText',p_message/i);
  assert.match(sql,/grant execute on function public\.ingest_native_roulette_soop_donation_v2[\s\S]*to service_role/i);
  assert.doesNotMatch(sql,/grant execute[\s\S]{0,200}to anon|grant execute[\s\S]{0,200}to authenticated/i);
});
