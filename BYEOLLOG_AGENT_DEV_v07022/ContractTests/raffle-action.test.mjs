import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const bytes = path => readFile(new URL(path, root));
const text = async path => (await bytes(path)).toString("utf8");

test("raffle action exposes ticket policy, independent placements, and a sealed manual draw console", async () => {
  const [ui, client, form, trust] = await Promise.all([
    text("Ui/agent_automation.html"),
    text("VNextAutomationClient.cs"),
    text("VNextAutomationSettingsForm.cs"),
    text("WebViewTrustPolicy.cs")
  ]);
  assert.match(ui, /<strong>추첨<\/strong>/);
  assert.match(ui, /const existingRaffle=state\.rules\.find\(rule=>rule\.action\?\.type==='raffle\.ticket_grant'\)/);
  assert.match(ui, /if\(existingRaffle\)\{\s*startEdit\(existingRaffle\)/);
  assert.match(ui, /이미 설정된 추첨 액션의 수정 화면을 열었습니다/);
  assert.match(ui, /id="raffleTicketUnit"[^>]+min="1"[^>]+max="1000000"/);
  assert.match(ui, /id="raffleAllowMultiples"[^>]+type="checkbox"/);
  assert.match(ui, /function renderRafflePolicyHelp\(\)/);
  assert.match(ui, /const twice=unit\*2,threePlusOne=unit\*3\+1/);
  assert.match(ui, /남는 금액은 버립니다/);
  assert.match(ui, /끄면 33개만 1장이고 66개·100개는 지급하지 않습니다/);
  assert.match(ui, /켜면 33개당 1장으로 계산해 66개는 2장, 100개는 3장/);
  assert.match(ui, /id="raffleTicketPreview"/);
  assert.match(ui, /id="raffleDrawPreview"/);
  assert.match(ui, /openPositionEditor\('raffle-ticket'\)/);
  assert.match(ui, /openPositionEditor\('raffle-draw'\)/);
  assert.match(ui, /id="raffleWinnerCount"[^>]+min="1"[^>]+max="100"/);
  assert.match(ui, /당첨 개수/);
  assert.match(ui, /id="raffleAllowDuplicates"[^>]+type="checkbox"/);
  assert.match(ui, /추첨 시작 · 추첨함 봉인/);
  assert.match(ui, /id="raffleLiveConsole"/);
  assert.match(ui, /id="raffleNextButton"[^>]*>다음 1장 추첨/);
  assert.match(ui, /새로 지급되는 추첨권은 자동으로 다음 회차에 적립/);
  assert.doesNotMatch(ui, /data-view="raffle"[^>]*>추첨 관리/);
  assert.match(ui, /manage\.textContent='추첨 관리'/);
  assert.match(ui, /manage\.hidden=rule\.action\.type!=='raffle\.ticket_grant'/);
  assert.match(ui, /manage\.onclick=\(\)=>switchView\('raffle'\)/);
  assert.match(ui, /actions\.append\(manage,test,edit,remove\)/);
  assert.match(ui, /id="raffleBackButton"[^>]*>← 액션 목록/);
  assert.match(ui, /raffleBackButton:document\.querySelector\('#raffleBackButton'\)/);
  assert.match(ui, /elements\.raffleBackButton\.onclick=\(\)=>switchView\('rules'\)/);
  assert.match(ui, /pendingRaffleStart=\{roundId,winnerCount,allowDuplicateWinners:allowDuplicates\}/);
  assert.match(ui, /function closeRaffleDrawConfirm\(\)\{elements\.raffleDrawConfirmLayer\.hidden=true;pendingRaffleStart=null\}/);
  assert.match(ui, /post\('startRaffleDraw',\{roundId,winnerCount,allowDuplicateWinners\}\)/);
  assert.match(ui, /pendingRaffleNext=\{drawId,agentDeviceId,expectedDrawIndex\}/);
  assert.match(ui, /function closeRaffleNextConfirm\(\)\{elements\.raffleNextConfirmLayer\.hidden=true;pendingRaffleNext=null\}/);
  assert.match(ui, /const request=pendingRaffleNext/);
  assert.match(ui, /post\('drawNextRaffleWinner',\{drawId,agentDeviceId,expectedDrawIndex\}\)/);
  assert.match(ui, /동일 당첨 재송출/);
  assert.match(ui, /이전 송출이 실제 방송에 보였을 수도 있습니다/);
  assert.match(ui, /createRaffleWinnerItem\(activeDraw\.drawId,winner\)/);
  assert.match(ui, /createRaffleWinnerItem\(draw\?\.drawId,winner\)/);
  assert.match(ui, /expectedReannounceNumber:request\.reannounceCount\+1/);
  assert.match(ui, /reannounceCount>=10/);
  assert.match(ui, /post\('reannounceRaffleWinner',\{drawId,drawIndex,expectedReannounceNumber\}\)/);
  assert.match(client, /save_guided_rule_v14/);
  assert.match(ui, /id="overlayVolumeRange"[^>]+min="0"[^>]+max="100"/);
  assert.match(ui, /id="testOverlaySoundButton"[^>]*>▶ 테스트 재생/);
  assert.match(ui, /post\('previewRaffleTts',\{kind:positionEditorTarget==='raffle-draw'\?'draw':'ticket',volumePercent:volumeDraft\}\)/);
  assert.ok(ui.includes("target==='raffle-draw'?'▶ 당첨 음성 듣기':'▶ 추첨권 음성 듣기'"));
  assert.match(ui, /raffleTicketVolumePercent/);
  assert.match(ui, /raffleDrawVolumePercent/);
  assert.match(client, /raffleTicketVolumePercent/);
  assert.match(client, /raffleDrawVolumePercent/);
  assert.match(form, /case "previewRaffleTts"/);
  assert.match(form, /ByeollogRaffleAudio\.PlayWinnerPreviewAsync\(volumePercent, _lifetimeToken\)/);
  assert.match(form, /ByeollogRaffleAudio\.PlayTicketAsync\(volumePercent, _lifetimeToken\)/);
  assert.doesNotMatch(form, /PreviewRaffleAudioInObsAsync\(/);
  assert.match(client, /"raffle\.ticket_grant"/);
  assert.match(client, /raffleAllowMultiples/);
  assert.match(client, /raffleTicketPositionX/);
  assert.match(client, /raffleDrawPositionX/);
  assert.match(client, /dispatch_guided_rule_test_v4/);
  assert.match(client, /get_raffle_state_v2/);
  assert.match(client, /start_raffle_draw_v2/);
  assert.doesNotMatch(client, /\/rest\/v1\/rpc\/draw_raffle_v1/);
  assert.doesNotMatch(client, /\/rest\/v1\/rpc\/start_raffle_draw_v1/);
  assert.match(client, /p_expected_round_id = normalizedRoundId/);
  assert.match(client, /returnedRoundId, normalizedRoundId/);
  assert.match(client, /draw_next_raffle_winner_v2/);
  assert.doesNotMatch(client, /\/rest\/v1\/rpc\/draw_next_raffle_winner_v1/);
  assert.match(client, /p_draw_id = normalizedDrawId/);
  assert.match(client, /p_expected_agent_device_id = normalizedAgentDeviceId/);
  assert.match(client, /returnedDrawId, normalizedDrawId/);
  assert.match(client, /returnedAgentDeviceId, normalizedAgentDeviceId/);
  assert.match(client, /returnedDrawIndex != expectedDrawIndex/);
  assert.match(client, /reannounce_raffle_winner_v1/);
  assert.match(client, /p_expected_reannounce_number = expectedReannounceNumber/);
  assert.match(client, /returnedReannounceNumber != expectedReannounceNumber/);
  assert.match(client, /RequireResponseGuidString\(result, "originalExecutionId", "동일 당첨 재송출"\)/);
  assert.match(client, /RequireResponseGuidString\(result, "agentDeviceId", "동일 당첨 재송출"\)/);
  assert.match(client, /only one raffle ticket rule can be active at a time/);
  assert.match(client, /추첨 액션은 하나만 사용할 수 있습니다/);
  assert.match(form, /case "refreshRaffle"/);
  assert.match(form, /case "startRaffleDraw"/);
  assert.match(form, /case "drawNextRaffleWinner"/);
  assert.match(form, /DrawNextRaffleWinnerAsync[\s\S]*WaitForAckOutcomeAsync\([\s\S]*RafflePresentationAckTimeout/);
  assert.match(form, /송출이 자동 재시도 중이거나 3분 안에 끝나지 않았습니다/);
  assert.match(form, /오버레이 출력은 확인됐지만 TTS 재생에 실패했습니다/);
  assert.match(form, /case "reannounceRaffleWinner"/);
  assert.match(form, /ReannounceRaffleWinnerAsync[\s\S]*WaitForAckOutcomeAsync\([\s\S]*RafflePresentationAckTimeout/);
  assert.match(form, /오버레이와 TTS 송출 완료/);
  assert.match(form, /다른 PC에 재송출 요청했어요/);
  assert.match(form, /TestRuleAsync[\s\S]*WaitForAckOutcomeAsync\([\s\S]*RafflePresentationAckTimeout/);
  assert.match(form, /TestRuleAsync[\s\S]*receipt\.ActionType,[\s\S]*RaffleOverlayActionAdapter\.ActionType,[\s\S]*DescribeRaffleDeliveryAck\(ack\)/);
  assert.match(form, /추첨 테스트 완료 · \{deliveryCopy\}/);
  assert.match(form, /RafflePresentationAckTimeout = TimeSpan\.FromMinutes\(3\)/);
  assert.equal((form.match(/RafflePresentationAckTimeout/g) || []).length, 4);
  assert.match(form, /if \(!ack\.Succeeded\)[\s\S]*automation_test_failed/);
  assert.match(trust, /"startRaffleDraw"/);
  assert.match(trust, /"drawNextRaffleWinner"/);
  assert.match(trust, /"reannounceRaffleWinner"/);
});

test("raffle completion UI observes durable local outcomes without pretending network delivery", async () => {
  const [agent, store] = await Promise.all([
    text("VNextLocalAgent.cs"),
    text("VNextAgentStore.cs")
  ]);
  const waitStart = agent.indexOf("public async Task<VNextAgentAck?> WaitForAckOutcomeAsync");
  const waitEnd = agent.indexOf("private void Publish", waitStart);
  const waitBody = agent.slice(waitStart, waitEnd);
  assert.ok(waitStart >= 0 && waitEnd > waitStart);
  assert.match(waitBody, /_store\.GetRecordedAck\(executionId\)/);
  assert.doesNotMatch(waitBody, /_store\.GetSentAck\(executionId\)/);
  assert.match(waitBody, /VNextAgentStore\.IsFinalLocalOutcome\(ack\)/);
  assert.match(store, /IsFinalLocalOutcome\(VNextAgentAck ack\)[\s\S]*ack\.Succeeded \|\| !ack\.Retryable/);
  assert.match(store, /public VNextAgentAck\? GetRecordedAck\(string executionId\)/);
  assert.match(store, /public VNextAgentAck\? GetSentAck\(string executionId\)/);
  assert.match(store, /GetSentAck[\s\S]*delivery_status = 'sent'/);
});

test("both raffle overlay resources are real, immutable, embedded animated GIFs", async () => {
  const [ticket, draw, project, cache, adapter] = await Promise.all([
    bytes("Assets/byeollog_raffle_ticket_granted.gif"),
    bytes("Assets/byeollog_raffle_draw.gif"),
    text("HurogiCollector.csproj"),
    text("OverlayAssetCache.cs"),
    text("RaffleOverlayActionAdapter.cs")
  ]);
  assert.equal(ticket.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(draw.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(createHash("sha256").update(ticket).digest("hex"), "104470fa1839c6b8711863aed35d6a33ff52c6fb1dabc93e616da0441c190b86");
  assert.equal(createHash("sha256").update(draw).digest("hex"), "4a21dcdb62ac5bae96159dcebb33dd0215a4cedd17218561cac5d04004923d80");
  assert.equal(ticket.readUInt16LE(6), 640);
  assert.equal(ticket.readUInt16LE(8), 400);
  assert.equal(draw.readUInt16LE(6), 640);
  assert.equal(draw.readUInt16LE(8), 640);
  assert.equal(draw.includes(Buffer.from("NETSCAPE2.0", "ascii")), true);
  assert.match(project, /byeollog_raffle_ticket_granted\.gif/);
  assert.match(project, /byeollog_raffle_draw\.gif/);
  assert.match(cache, /RaffleTicketGrantedAssetKey/);
  assert.match(cache, /RaffleDrawAssetKey/);
  assert.match(adapter, /kind == "ticket_granted"/);
  assert.match(adapter, /kind == "draw_result"/);
  assert.match(adapter, /kind != "test_sequence"/);
  assert.match(adapter, /RAFFLE_TEST_SEQUENCE_COMPLETED/);
  assert.match(adapter, /TicketSpeechText\s*=\s*"추첨권을 드렸어요!"/);
  assert.match(adapter, /\$"\{displayName\}, 추첨권 \{granted\}장!"/);
  assert.doesNotMatch(adapter, /추첨함에 총/);
  assert.match(adapter, /TicketSpeechPreparation/);
  assert.match(adapter, /WinnerSpeechPreparation/);
  assert.match(adapter, /executionId/);
  assert.match(adapter, /attemptNo/);
  assert.doesNotMatch(adapter, /KoreanTicketCounter/);
  assert.match(adapter, /volumePercent/);
  assert.match(adapter, /TicketPlacement/);
  assert.match(adapter, /DrawPlacement/);
  assert.match(adapter, /for \(var index = 0; index < presentation\.WinnerNames\.Count; index\+\+\)/);
  assert.match(adapter, /\$"추첨 \{firstDrawIndex \+ index\}\/\{winnerTarget\}"/);
  assert.match(adapter, /parameters\.TryGetProperty\("drawIndex"/);
  assert.match(adapter, /parameters\.TryGetProperty\("winnerTarget"/);
  assert.doesNotMatch(adapter, /innerHTML/);
});

test("raffle artwork generation fails closed on opaque GIF backgrounds and the live copy has no dark panel", async () => {
  const [generator, overlay] = await Promise.all([
    text("tools/generate_raffle_gifs.py"),
    text("ByeollogOverlayService.cs"),
  ]);
  assert.match(generator, /def verify_transparent_gif/);
  assert.match(generator, /opaque GIF background detected/);
  assert.match(generator, /output\.info\["transparency"\] = 0/);
  assert.match(generator, /def build_raffle_ticket/);
  assert.equal((generator.match(/build_raffle_ticket\(s\)/g) || []).length, 1);
  const grantedTicketGenerator = generator.slice(
    generator.indexOf("def build_raffle_ticket"),
    generator.indexOf("def build_ticket_artwork")
  );
  assert.match(grantedTicketGenerator, /ticket_draw\.polygon\(star_points/);
  assert.match(generator, /TICKET_CANVAS_HEIGHT = 400/);
  assert.match(generator, /Image\.new\("RGBA", \(CANVAS_SIZE, TICKET_CANVAS_HEIGHT\)/);
  assert.match(generator, /def sparkle/);
  assert.match(generator, /sparkle\(draw, x, y/);
  assert.match(generator, /DRAW_FRAME_COUNT = 32/);
  assert.match(generator, /def build_draw_ticket/);
  assert.match(generator, /def build_draw_layers/);
  assert.match(generator, /start_y = 356/);
  assert.match(generator, /finish_y = 76/);
  assert.match(generator, /progress = eased \* 1\.045/);
  assert.match(generator, /moved_ticket\.alpha_composite\(transformed_ticket, \(ticket_x, ticket_y\)\)/);
  assert.match(generator, /canvas\.alpha_composite\(front_lip\)/);
  assert.match(generator, /allow_bottom_edge_artwork/);
  assert.match(generator, /save_gif\(build_draw_frames\(draw_layers\), draw_path, loop=0, allow_bottom_edge_artwork=True\)/);
  assert.doesNotMatch(generator, /retract =/);
  assert.match(overlay, /#raffle-copy \{[^}]*background: transparent;/);
  assert.doesNotMatch(overlay, /#raffle-copy \{[^}]*linear-gradient/);
});

test("raffle artwork and copy share one placement and scale stage", async () => {
  const overlay = await text("ByeollogOverlayService.cs");
  assert.match(overlay, /<div id="raffle-stage"[^>]*><img id="raffle-asset"[\s\S]*<section id="raffle-copy"/);
  assert.match(overlay, /#raffle-copy \{[^}]*top: calc\(100% \+ clamp\(2px, \.4vh, 6px\)\)/);
  assert.match(overlay, /#raffle-copy \{[^}]*width: 180%;/);
  assert.doesNotMatch(overlay, /id="raffle-secondary"|id="raffle-winners"/);
  assert.match(overlay, /#raffle-primary \{[^}]*white-space: nowrap;/);
  assert.match(overlay, /function applyRafflePlacement\(state\)/);
  assert.match(overlay, /raffleStage\.style\.left = Number\.isInteger\(state\.positionX\)/);
  assert.match(overlay, /raffleStage\.style\.top = Number\.isInteger\(state\.positionY\)/);
  assert.match(overlay, /raffleStage\.style\.transform = 'translate\(-50%, -50%\) scale\(' \+ scale \+ '\)'/);
  assert.match(overlay, /const targetAsset = raffle \? raffleAsset : flashbang \? flashbangAsset : asset/);
  assert.doesNotMatch(overlay, /#raffle-copy \{[^}]*bottom:/);
});

test("raffle action refreshes a stale OBS browser document before its first output", async () => {
  const adapter = await text("RaffleOverlayActionAdapter.cs");
  const overlay = await text("ByeollogOverlayService.cs");
  const localAgent = await text("VNextLocalAgent.cs");
  assert.match(adapter, /EnsureCurrentOverlayDocumentAsync\(cancellationToken\)/);
  assert.match(adapter, /_refreshBrowserSources\(timeout\.Token\)/);
  assert.match(adapter, /requireNewRequest:\s*true/);
  assert.match(adapter, /_currentDocumentObserved/);
  assert.match(overlay, /DocumentRevision\s*=\s*"raffle-compact-copy-v6"/);
  assert.match(overlay, /data-document-revision="raffle-compact-copy-v6"/);
  assert.match(overlay, /media-src 'self'/);
  assert.match(overlay, /audioContentSha256/);
  assert.match(overlay, /audioPresentationRevision/);
  assert.match(overlay, /\/overlay\/audio-events\//);
  assert.match(overlay, /ShowObservedAudioTransientAsync/);
  assert.match(localAgent, /new RaffleOverlayActionAdapter\([\s\S]*?RefreshOverlayBrowserSourcesAsync\([\s\S]*?_overlay\.OverlayUrl/);
  assert.match(localAgent, /EnsureOverlayBrowserAudioRoutingAsync\([\s\S]*?_overlay\.OverlayUrl/);
});
