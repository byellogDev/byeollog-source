import assert from 'node:assert/strict';
import test from 'node:test';
import {classifySoopChatSdkCallback,isSoopBroadcastOfflineError,normalizeSoopChatSdkCallback,shouldSendSoopGatewayHeartbeat,SOOP_GATEWAY_HEARTBEAT_POLICY,stableSoopGatewayStaggerMs,SoopGatewayReplayGuard,SoopRelevantChatGate} from '../lib/soop-chat-gateway.js';
import {soopBrowserRuntimePolicy,soopBrowserShardCount,soopBrowserShardExpired} from '../services/soop-chat-gateway/browser-session.mjs';

function callback(overrides={}){
  return {
    action:'MESSAGE',
    message:{userId:'Viewer01',userNickname:'시청자',message:'딸깍'},
    receivedAt:'2026-08-29T03:00:00.100Z',
    connection:{id:'gateway-a:workspace:1',sequence:7,reconnectCount:0},
    ...overrides
  };
}

test('SDK chat callback becomes the strict relay envelope without leaking provider aliases',()=>{
  const value=normalizeSoopChatSdkCallback(callback());
  assert.equal(value.relay.eventType,'chat');
  assert.equal(value.relay.event.actor.id,'viewer01');
  assert.equal(value.relay.event.message,'딸깍');
  assert.equal(value.relay.event.eventId,'sdk:gateway-a:workspace:1:7');
  assert.equal(value.metadata.occurredAtSource,'gateway_receive');
  assert.match(value.relay.rawPayloadSha256,/^[0-9a-f]{64}$/);
});

test('provider event id and time are preferred when the SDK exposes them',()=>{
  const value=normalizeSoopChatSdkCallback(callback({
    action:'BALLOON_GIFTED',
    message:{eventId:'gift-123',userId:'Viewer01',userNickname:'시청자',count:33,occurredAt:'2026-08-29T03:00:00.000Z'}
  }));
  assert.equal(value.relay.eventType,'donation');
  assert.equal(value.relay.event.eventId,'gift-123');
  assert.equal(value.relay.event.amount,33);
  assert.equal(value.relay.event.donationTypeLabel,'별풍선');
  assert.equal(value.metadata.explicitEventId,true);
  assert.equal(value.metadata.occurredAtSource,'provider');
});

test('official SOOP mission gift actions preserve their exact display kind',()=>{
  for(const [action,label] of [
    ['BATTLE_MISSION_GIFTED','대결미션'],
    ['CHALLENGE_MISSION_GIFTED','도전미션'],
    ['CHALLENGE_MISSION_SPONSORS','도전미션']
  ]){
    const value=normalizeSoopChatSdkCallback(callback({
      action,message:{userId:'Viewer01',userNickname:'시청자',count:330}
    }));
    assert.equal(value.relay.eventType,'donation');
    assert.equal(value.relay.event.donationTypeLabel,label);
  }
});

test('SDK donation records a privacy-safe image diagnostic and normalizes legacy provider URLs',()=>{
  const value=normalizeSoopChatSdkCallback(callback({
    action:'CHALLENGE_MISSION_GIFTED',
    message:{userId:'Viewer01',userNickname:'시청자',count:330,imageUrl:'//static.file.sooplive.com/mission/private-path.png?token=secret'}
  }));
  assert.equal(value.relay.event.ceremonyImageUrl,'https://static.file.sooplive.com/mission/private-path.png?token=secret');
  assert.deepEqual(value.metadata.ceremonyImage,{
    fieldPresent:true,valuePresent:true,accepted:true,scheme:'https',hostname:'static.file.sooplive.com'
  });
  assert.doesNotMatch(JSON.stringify(value.metadata.ceremonyImage),/private-path|secret/);
});

test('current SOOP SDK root-relative mission image resolves only against the official asset host',()=>{
  const value=normalizeSoopChatSdkCallback(callback({
    action:'CHALLENGE_MISSION_GIFTED',
    message:{userId:'Viewer01',userNickname:'시청자',count:330,imageUrl:'/images/chat/mission/challenge-330.png'}
  }));
  assert.equal(value.relay.event.ceremonyImageUrl,'https://res.sooplive.com/images/chat/mission/challenge-330.png');
  assert.deepEqual(value.metadata.ceremonyImage,{
    fieldPresent:true,valuePresent:true,accepted:true,scheme:'relative',hostname:'res.sooplive.com'
  });
});

test('SDK donation distinguishes a genuinely missing image from a rejected image',()=>{
  const missing=normalizeSoopChatSdkCallback(callback({
    action:'BALLOON_GIFTED',message:{userId:'Viewer01',userNickname:'시청자',count:1}
  }));
  assert.deepEqual(missing.metadata.ceremonyImage,{
    fieldPresent:false,valuePresent:false,accepted:false,scheme:'missing',hostname:null
  });
  const rejected=normalizeSoopChatSdkCallback(callback({
    action:'BALLOON_GIFTED',message:{userId:'Viewer01',userNickname:'시청자',count:1,imageUrl:'https://example.com/private.png'}
  }));
  assert.equal(rejected.relay.event.ceremonyImageUrl,null);
  assert.deepEqual(rejected.metadata.ceremonyImage,{
    fieldPresent:true,valuePresent:true,accepted:false,scheme:'https',hostname:'example.com'
  });
});

test('non-content SDK actions are ignored instead of guessed',()=>{
  assert.equal(normalizeSoopChatSdkCallback(callback({action:'JOIN'})),null);
  assert.throws(()=>normalizeSoopChatSdkCallback(callback({message:{userId:'viewer'}})),/메시지/);
});

test('unusable content packets are classified without becoming delivery failures',()=>{
  assert.deepEqual(classifySoopChatSdkCallback(callback({action:'JOIN'})),{kind:'ignored',action:'JOIN',reason:'unsupported_action'});
  assert.deepEqual(classifySoopChatSdkCallback(callback({message:{userNickname:'익명',message:'안녕'}})),{kind:'ignored',action:'MESSAGE',reason:'missing_actor_id'});
  assert.deepEqual(classifySoopChatSdkCallback(callback({message:{userId:'viewer',message:''}})),{kind:'ignored',action:'MESSAGE',reason:'missing_chat_message'});
  assert.deepEqual(classifySoopChatSdkCallback(callback({action:'BALLOON_GIFTED',message:{userId:'viewer',count:0}})),{kind:'ignored',action:'BALLOON_GIFTED',reason:'invalid_donation_amount'});
  const accepted=classifySoopChatSdkCallback(callback());
  assert.equal(accepted.kind,'event');
  assert.equal(accepted.value.relay.eventType,'chat');
});

test('replay guard drops cross-reconnect replay but keeps legitimate repeated chat in one connection',()=>{
  const guard=new SoopGatewayReplayGuard({ttlMs:15_000});
  const base={signature:'a'.repeat(64),connectionId:'session-a',now:100_000};
  assert.equal(guard.check(base),false);
  assert.equal(guard.check({...base,now:100_010}),false);
  assert.equal(guard.check({...base,connectionId:'session-b',now:101_000}),true);
  assert.equal(guard.check({...base,connectionId:'session-c',now:116_001}),false);
});

test('explicit provider id is idempotent even inside one connection',()=>{
  const guard=new SoopGatewayReplayGuard();
  const event={signature:'b'.repeat(64),connectionId:'session-a',explicitEventId:true,now:200_000};
  assert.equal(guard.check(event),false);
  assert.equal(guard.check({...event,now:200_001}),true);
});

test('only chats from a recently donating actor cross the cloud boundary',()=>{
  const gate=new SoopRelevantChatGate({windowMs:120_000});
  gate.arm({id:'Viewer01',name:'후원자'}, {now:1_000_000});
  assert.equal(gate.shouldForward({id:'viewer01',name:'다른표시명'},{now:1_000_001}),true);
  assert.equal(gate.shouldForward({id:'another',name:'후원자'},{now:1_000_002}),true);
  assert.equal(gate.shouldForward({id:'viewer02',name:'일반시청자'},{now:1_000_003}),false);
  assert.equal(gate.shouldForward({id:'viewer01',name:'후원자'},{now:1_120_001}),false);
});

test('arming a donation extends the donor chat window without buffering the donation',()=>{
  const gate=new SoopRelevantChatGate({windowMs:15_000});
  gate.arm({id:'viewer01',name:'후원자'},{now:100_000});
  gate.arm({id:'viewer01',name:'후원자'},{now:110_000});
  assert.equal(gate.shouldForward({id:'viewer01',name:'후원자'},{now:124_999}),true);
  assert.equal(gate.shouldForward({id:'viewer01',name:'후원자'},{now:125_001}),false);
});

test('steady live heartbeat is coalesced without delaying state or error transitions',()=>{
  assert.deepEqual(SOOP_GATEWAY_HEARTBEAT_POLICY,{checkMs:15_000,connectedMs:60_000,offlineMs:300_000});
  const steady={
    lastHeartbeatAt:1_000_000,reportedState:'connected',lastHeartbeatState:'connected',
    lastErrorCode:null,lastHeartbeatError:null
  };
  assert.equal(shouldSendSoopGatewayHeartbeat({...steady,now:1_059_999}),false);
  assert.equal(shouldSendSoopGatewayHeartbeat({...steady,now:1_060_000}),true);
  assert.equal(shouldSendSoopGatewayHeartbeat({...steady,now:1_000_001,reportedState:'retry_wait'}),true);
  assert.equal(shouldSendSoopGatewayHeartbeat({...steady,now:1_000_001,lastErrorCode:'sdk_closed'}),true);
  const offline={...steady,reportedState:'waiting_for_live',lastHeartbeatState:'waiting_for_live'};
  assert.equal(shouldSendSoopGatewayHeartbeat({...offline,now:1_299_999}),false);
  assert.equal(shouldSendSoopGatewayHeartbeat({...offline,now:1_300_000}),true);
});

test('workspace startup and reconnect staggering is stable and bounded',()=>{
  const first=stableSoopGatewayStaggerMs('workspace-a',5_000);
  assert.equal(first,stableSoopGatewayStaggerMs('workspace-a',5_000));
  assert.ok(first>=0&&first<=5_000);
  assert.ok(stableSoopGatewayStaggerMs('workspace-b',5_000)>=0);
  assert.equal(stableSoopGatewayStaggerMs('workspace-a',0),0);
});

test('current SOOP SDK error 104 is a normal offline broadcast state',()=>{
  assert.equal(isSoopBroadcastOfflineError(new Error('sdk-error: There are no streams currently in progress.(104)')),true);
  assert.equal(isSoopBroadcastOfflineError({errorCode:'104',errorMessage:'idle'}),true);
  assert.equal(isSoopBroadcastOfflineError({code:'ECONNRESET',message:'socket closed'}),false);
});

test('browser sessions are partitioned into bounded failure-isolation shards',()=>{
  assert.equal(soopBrowserShardCount(0,16),0);
  assert.equal(soopBrowserShardCount(1,16),1);
  assert.equal(soopBrowserShardCount(16,16),1);
  assert.equal(soopBrowserShardCount(17,16),2);
  assert.equal(soopBrowserShardCount(100,16),7);
  assert.equal(soopBrowserShardCount(2,1),2);
  assert.deepEqual(soopBrowserRuntimePolicy(),{browserProcesses:1,rendererProcessLimit:8,sessionsPerShard:16,shardMaxAgeMs:300_000});
  assert.throws(()=>soopBrowserShardCount(-1,16),/Session count/);
});

test('browser SDK shards expire only after the configured refresh interval',()=>{
  assert.equal(soopBrowserShardExpired(1_000,300_999,300_000),false);
  assert.equal(soopBrowserShardExpired(1_000,301_000,300_000),true);
  assert.equal(soopBrowserShardExpired(1_000,301_001,300_000),true);
});
