import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Agent owns a loopback-only Browser Source with observed liveness and three distinct scalable packaged images", async () => {
  const [service, project, asset, icon, signalPanel, screenprint, cache, obs, obsClient] = await Promise.all([
    readFile(new URL("ByeollogOverlayService.cs", root), "utf8"),
    readFile(new URL("HurogiCollector.csproj", root), "utf8"),
    readFile(new URL("Assets/byeollog_mic_off_overlay.svg", root), "utf8"),
    readFile(new URL("Assets/byeollog_mic_off_icon.png", root)),
    readFile(new URL("Assets/byeollog_mic_off_signal_panel.png", root)),
    readFile(new URL("Assets/byeollog_mic_off_screenprint.png", root)),
    readFile(new URL("OverlayAssetCache.cs", root), "utf8"),
    readFile(new URL("ObsActionAdapter.cs", root), "utf8"),
    readFile(new URL("ObsWebSocketClient.cs", root), "utf8")
  ]);
  assert.match(service, /new TcpListener\(IPAddress\.Loopback, port\)/);
  assert.match(service, /http:\/\/127\.0\.0\.1:\{Port\}\/overlay/);
  assert.match(service, /string\.Equals\(method, "GET"/);
  assert.match(service, /string\.Equals\(method, "HEAD"/);
  assert.match(service, /\/overlay\/state/);
  assert.match(service, /\/overlay\/assets\//);
  assert.match(service, /AssetToken/);
  assert.match(service, /ActiveContentForToken/);
  assert.match(service, /OverlayAssetContent\? _activeContent/);
  assert.match(service, /WaitForBrowserSourceAsync/);
  assert.match(service, /LastStateRequestAtUtc/);
  assert.doesNotMatch(service, /IPAddress\.Any|0\.0\.0\.0/);
  assert.match(project, /<Version>0\.7\.0\.[0-9]+<\/Version>/);
  assert.match(project, /byeollog_mic_off_overlay\.svg/);
  assert.match(project, /byeollog_mic_off_icon\.png/);
  assert.match(cache, /SHA256\.HashData/);
  assert.match(cache, /AtomicWriteAsync/);
  assert.match(cache, /DtdProcessing\.Prohibit/);
  assert.match(cache, /RequiredReady/);
  assert.match(asset, /마이크 OFF/);
  assert.equal(createHash("sha256").update(icon).digest("hex"), "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464");
  assert.equal(createHash("sha256").update(signalPanel).digest("hex"), "b62c2855b315c201cecdf53621d1200806a81fa2f3cc292945081fc313ec4888");
  assert.equal(createHash("sha256").update(screenprint).digest("hex"), "b2d94f9dba81ccbd9642961ec5bbb5bfc2f51da24cd72d0ac1c302de3ff59ccf");
  assert.match(cache, /MicrophoneOffCenterAssetKey = "mic_off_center"/);
  assert.match(cache, /MicrophoneOffSignalPanelAssetKey = "mic_off_signal_panel"/);
  assert.match(cache, /MicrophoneOffScreenprintAssetKey = "mic_off_screenprint"/);
  assert.match(service, /center-icon/);
  assert.match(service, /top-left-icon/);
  assert.match(service, /top-right-icon/);
  assert.match(obs, /RefreshOverlayBrowserSourcesAsync/);
  assert.match(service, /IsMatchingLoopbackOverlayUrl/);
  assert.match(obs, /refreshnocache/);
  assert.match(obsClient, /PressInputPropertiesButton/);
});

test("Collector source provides one-click SDK check, tests, EXE, and ZIP build", async () => {
  const oneClick = await readFile(new URL("../00_BUILD_V070_RC2_ONE_CLICK.cmd", import.meta.url), "utf8");
  const publish = await readFile(new URL("../02_PUBLISH.cmd", import.meta.url), "utf8");
  assert.match(oneClick, /Microsoft\.DotNet\.SDK\.8/);
  assert.match(oneClick, /call "%~dp002_PUBLISH\.cmd"/);
  assert.match(publish, /AgentStoreTests\\AgentStoreTests\.csproj/);
  assert.match(publish, /dotnet publish/);
  assert.match(publish, /Seal-TesterZip\.ps1/);
});

test("Agent reports bounded capabilities and packaged overlay-image readiness for device management", async () => {
  const [client, agent, publish] = await Promise.all([
    readFile(new URL("VNextDevelopmentClient.cs", root), "utf8"),
    readFile(new URL("VNextLocalAgent.cs", root), "utf8"),
    readFile(new URL("../02_PUBLISH.cmd", import.meta.url), "utf8")
  ]);
  assert.match(client, /ReportAgentDeviceStatusAsync/);
  assert.match(client, /operation = "device_status"/);
  assert.match(client, /NormalizeSupportedActionTypes/);
  assert.match(client, /managedOverlayAssets is < 0 or > 100/);
  assert.match(client, /readyOverlayAssets = normalizedReadyOverlayAssets/);
  assert.match(agent, /AgentVersion\s*=\s*BuildInfo\.Version/);
  assert.match(agent, /DeviceStatusInterval = TimeSpan\.FromSeconds\(30\)/);
  assert.match(agent, /overlayStatus\.RequiredReady/);
  assert.match(agent, /overlayStatus\.ManagedCount/);
  assert.match(agent, /ReadyRevisionsAsync/);
  assert.match(publish, /byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64\.zip/);
});

test("Agent reports Weflab collection health separately from its automation heartbeat", async () => {
  const [client, agent, storage, form] = await Promise.all([
    readFile(new URL("VNextDevelopmentClient.cs", root), "utf8"),
    readFile(new URL("VNextLocalAgent.cs", root), "utf8"),
    readFile(new URL("CollectorStorage.cs", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8")
  ]);
  assert.match(client, /operation = "collection_health"/);
  assert.match(client, /operation = "device_status"[\s\S]*operation = "collection_health"/);
  assert.match(client, /_agentRequestJsonWithNulls[\s\S]*JsonIgnoreCondition\.Never/);
  assert.match(client, /operation = "collection_health"[\s\S]*preserveNulls:\s*true/);
  assert.match(client, /invalid_collection_health/);
  assert.match(client, /invalid_operation/);
  assert.match(agent, /vNext Agent 반복 처리 오류/);
  assert.match(agent, /session\?\.Active != true[\s\S]*VNextCollectionHealth\("idle"/);
  assert.match(agent, /LastWeflabObservedAt\.HasValue \? "active" : "recovering"/);
  assert.match(storage, /MarkWeflabObserved/);
  assert.match(storage, /MarkSuccessfulUpload/);
  assert.match(form, /kind == "probe"[\s\S]*HandleWeflabLoginCandidate/);
  assert.match(form, /HandleWeflabApiSuccess\("후원 API 정상 응답"\)/);
  assert.match(form, /MarkWeflabObserved\(DateTimeOffset\.UtcNow\)/);
});

test("preflight checks readiness without mutating OBS and exports a privacy-safe report", async () => {
  const [preflight, store, storage, form] = await Promise.all([
    readFile(new URL("CollectorPreflight.cs", root), "utf8"),
    readFile(new URL("VNextAgentStore.cs", root), "utf8"),
    readFile(new URL("CollectorStorage.cs", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8")
  ]);
  assert.match(store, /PRAGMA quick_check\(1\)/);
  assert.match(store, /PRAGMA foreign_key_check/);
  assert.match(preflight, /127\.0\.0\.1/);
  assert.match(preflight, /\/overlay\/health/);
  assert.match(preflight, /GetVersionAsync/);
  assert.match(preflight, /GetInputMuteAsync/);
  assert.doesNotMatch(preflight, /SetInputMuteAsync/);
  assert.match(preflight, /PendingAcks/);
  assert.match(preflight, /Uncertain/);
  assert.match(preflight, /ExactAssetsReady/);
  assert.match(preflight, /BroadcastReadinessPolicy\.ExactAssetsReady/);
  assert.match(preflight, /scope\.RequiredOverlayAssetIds/);
  assert.match(preflight, /approvedAssets/);
  assert.match(preflight, /overlay\.ReadyRevisions/);
  const exportedAgentMetrics = preflight.slice(
    preflight.indexOf("internal sealed record CollectorPreflightAgentMetrics("),
    preflight.indexOf("internal sealed record CollectorPreflightObsMetrics(")
  );
  const exportedReport = preflight.slice(
    preflight.indexOf("internal sealed record CollectorPreflightReport("),
    preflight.indexOf("internal static partial class CollectorPreflightRunner")
  );
  assert.doesNotMatch(exportedAgentMetrics, /\b(?:DeviceId|WorkspaceId|StreamerName)\b/);
  assert.doesNotMatch(exportedReport, /\b(?:DeviceId|WorkspaceId|StreamerName)\b/);
  assert.match(storage, /preflight\.json/);
  assert.match(storage, /OBS 입력명, OBS 비밀번호, Agent 장치 ID/);
  assert.match(form, /방송 준비 사전진단 \(읽기 전용\)/);
  assert.match(form, /사전진단 \+ 진단 ZIP 만들기/);
});

test("real-device acceptance is observational, exact-revision bound, and privacy safe", async () => {
  const [core, runner, service, store, storage, form, publish] = await Promise.all([
    readFile(new URL("CollectorAcceptanceCore.cs", root), "utf8"),
    readFile(new URL("CollectorAcceptanceRunner.cs", root), "utf8"),
    readFile(new URL("ByeollogOverlayService.cs", root), "utf8"),
    readFile(new URL("VNextAgentStore.cs", root), "utf8"),
    readFile(new URL("CollectorStorage.cs", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8"),
    readFile(new URL("../02_PUBLISH.cmd", import.meta.url), "utf8")
  ]);
  assert.match(runner, /WaitForFirstObsTimedMuteAsync/);
  assert.match(runner, /TimeSpan\.FromMinutes\(30\)/);
  assert.match(store, /FindFirstObsTimedMuteSince/);
  assert.match(store, /i\.action_type = 'obs\.mute_for'/);
  assert.match(core, /DurationMs == 10_000/);
  assert.match(core, /ExactOverlayRevisionMatched/);
  assert.match(core, /confirmed_obs_and_freeshot/);
  assert.match(core, /ActiveBrowserPolls > 0/);
  assert.match(service, /Interlocked\.Increment\(ref _activeStateRequests\)/);
  assert.match(form, /아봉10초 최종 실기기 검증 \(실제 이벤트 1회\)/);
  assert.match(form, /TimeSpan\.FromMinutes\(15\)/);
  assert.doesNotMatch(form, /RunLocalObsTestAsync[\s\S]{0,500}RunAcceptanceEvidenceAsync/);
  assert.match(storage, /acceptance\.json/);
  assert.match(storage, /실행 ID, 이벤트 ID, 워크스페이스·계정·장치 식별자/);
  assert.doesNotMatch(core, /ExecutionId|EventId|WorkspaceId|DeviceId|Password|Token/);
  assert.match(publish, /node --test/);
  assert.match(publish, /if errorlevel 1 goto no_node/);
  assert.match(publish, /Node\.js is required to verify the source contracts before packaging/);
  assert.doesNotMatch(publish, /preverified source contracts/i);
});

test("exact readiness is catalog-bound and revalidates bytes before every report", async () => {
  const [cache, client, automationUi] = await Promise.all([
    readFile(new URL("OverlayAssetCache.cs", root), "utf8"),
    readFile(new URL("VNextDevelopmentClient.cs", root), "utf8"),
    readFile(new URL("Ui/agent_automation.html", root), "utf8")
  ]);
  assert.match(cache, /BuiltInAssetId = "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc"/);
  assert.match(cache, /ReadyRevisionsAsync/);
  assert.match(cache, /File\.ReadAllBytesAsync\(AbsolutePath\(entry\.RelativePath\)/);
  assert.match(cache, /OverlayAssetValidator\.VerifyBytes\(bytes, descriptor\)/);
  assert.match(cache, /_entries\.Remove\(entry\.AssetId\)/);
  assert.match(client, /readyOverlayAssets\.Count > 100/);
  assert.match(client, /Sha256Pattern\.IsMatch\(item\.ContentSha256\)/);
  assert.match(cache, /LegacyBuiltInAssetKey = "microphone_off"/);
  assert.match(cache, /LegacyBuiltInDeliveryMode = "builtin"/);
  assert.match(cache, /TryNormalizeExactBuiltIn/);
  assert.match(cache, /BuiltInAssetId/);
  assert.match(cache, /BuiltInContentSha256/);
  assert.match(automationUi, /계정 연결은 정상입니다\. 준비 상태 새로고침/);
});

test("OBS mute and managed overlay share one observed presentation and one Agent action", async () => {
  const [contract, adapter, overlay, agent, form] = await Promise.all([
    readFile(new URL("TimedMuteActionCore.cs", root), "utf8"),
    readFile(new URL("TimedMuteActionAdapter.cs", root), "utf8"),
    readFile(new URL("ByeollogOverlayService.cs", root), "utf8"),
    readFile(new URL("VNextLocalAgent.cs", root), "utf8"),
    readFile(new URL("MainForm.cs", root), "utf8")
  ]);
  assert.match(contract, /MicrophoneOffOverlayAssetKey = "mic_off"/);
  assert.match(contract, /"overlayAssetId"/);
  assert.match(contract, /"overlayScalePercent"/);
  assert.match(contract, /TimedMuteOverlayPlacement/);
  assert.match(contract, /x is < 0 or > 10_000/);
  assert.match(adapter, /ExecuteMuteAndOverlayAsync/);
  assert.match(adapter, /_overlay\.ShowSynchronizedAsync/);
  assert.match(adapter, /onOverlayObservedAndMuteActive/);
  assert.match(contract, /Action\? onActivated = null/);
  assert.match(contract, /session\.Active = true/);
  assert.match(overlay, /WaitForActivePresentationAsync/);
  assert.match(overlay, /session\.SideEffectStarted\.Task\.WaitAsync/);
  assert.match(adapter, /EnsureOverlayBrowserSourceReadyAsync/);
  assert.match(adapter, /WaitForBrowserSourceAsync/);
  assert.match(adapter, /overlayEvidence is \{ ActiveStateRequestDelta: > 0 \}/);
  assert.match(overlay, /currentDocumentActiveStateRequests/);
  assert.doesNotMatch(adapter, /overlayAfter\.AssetRequests > 0/);
  assert.match(adapter, /overlayDisplayed = overlayAsset is not null && overlayObserved/);
  assert.match(adapter, /overlayAssetId[\s\S]+overlayAssetVersion[\s\S]+overlayContentSha256/);
  assert.match(agent, /VNextActionFreshness\.ValidateAndStrip/);
  assert.match(agent, /ExecuteObsAsync\(\s*actionParameters/);
  assert.match(agent, /new TimedMuteActionAdapter\(collectorStorage, _overlay\)/);
  assert.match(agent, /SyncOverlayAssetsAsync/);
  assert.match(agent, /job\.OverlayAsset/);
  assert.match(form, /OBS 브라우저 소스 주소 복사/);
  assert.match(form, /마이크 꺼짐 이미지 3초 미리보기/);
  assert.doesNotMatch(form, /승인 이미지/);
});
