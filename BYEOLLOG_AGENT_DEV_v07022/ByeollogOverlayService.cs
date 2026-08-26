using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record ByeollogOverlaySnapshot(
    long Revision,
    bool Active,
    string? AssetKey,
    string? AssetToken,
    int? AssetVersion,
    string? ContentSha256,
    int? PositionX,
    int? PositionY,
    int? ScalePercent,
    string? PresentationKind,
    string? PresentationTitle,
    string? PresentationPrimary,
    string? PresentationSecondary,
    IReadOnlyList<string>? WinnerNames,
    string? AudioToken,
    string? AudioContentSha256,
    int? AudioVolumePercent,
    long? AudioPresentationRevision,
    DateTimeOffset? HideAtUtc);

internal sealed record RaffleOverlayPresentation(
    string Kind,
    string Title,
    string Primary,
    string Secondary,
    IReadOnlyList<string> WinnerNames);

internal sealed record ByeollogOverlayTelemetrySnapshot(
    long Revision,
    bool Active,
    long StateRequests,
    long ActiveStateRequests,
    long AssetRequests,
    DateTimeOffset? LastStateRequestAtUtc,
    DateTimeOffset? LastActiveStateRequestAtUtc,
    DateTimeOffset? LastAssetRequestAtUtc);

internal sealed record ByeollogOverlayDisplayEvidence(
    long Revision,
    string AssetKey,
    long ActiveStateRequestsBefore,
    long ActiveStateRequestsAfter,
    DateTimeOffset ObservedAtUtc)
{
    public long ActiveStateRequestDelta =>
        Math.Max(0, ActiveStateRequestsAfter - ActiveStateRequestsBefore);
}

internal sealed record ByeollogSynchronizedDisplayResult<T>(
    T SideEffectResult,
    ByeollogOverlayDisplayEvidence OverlayEvidence);

internal sealed record RaffleOverlayAudioContent(
    byte[] Audio,
    string ContentSha256,
    int VolumePercent,
    string BindingKey);

internal sealed record ByeollogOverlayAudioEvidence(
    long PresentationRevision,
    bool Requested,
    bool Started,
    bool Ended,
    string? FailureType);

internal sealed record ByeollogObservedAudioDisplayResult(
    ByeollogOverlayDisplayEvidence OverlayEvidence,
    ByeollogOverlayAudioEvidence AudioEvidence);

internal sealed class OverlayPresentationNotObservedException : IOException
{
    public OverlayPresentationNotObservedException()
        : base("OBS 브라우저 소스가 별록 오버레이의 활성 상태를 확인하지 않았습니다.") { }
}

/// <summary>
/// OBS Browser Source가 한 번만 등록해 두는 localhost 전용 투명 오버레이입니다.
/// 표시할 이미지와 지속 시간은 Local Agent 액션이 관리하며 외부 HTTP 요청은 상태를
/// 변경할 수 없습니다.
/// </summary>
internal sealed class ByeollogOverlayService : IDisposable
{
    internal const string MicrophoneOffAssetKey = TimedMuteContract.MicrophoneOffOverlayAssetKey;
    internal const string DocumentRevision = "categorized-actions-v12";
    internal const int DefaultPort = 43_120;
    internal const int BrowserAudioStartTimeoutMs = 5_000;
    internal const int MaximumBrowserAudioPlaybackMs = 25_000;
    private static readonly byte[] OverlayHtml = Encoding.UTF8.GetBytes("""
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>별록 오버레이</title>
  <style>
    :root { color-scheme: only light; background: transparent; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { position: relative; }
    #asset { position: absolute; display: block; object-fit: contain; opacity: 0; transition: opacity 120ms ease-out; }
    #asset.visible { opacity: 1; }
    #asset.center-card { width: min(42vw, 820px); height: auto; max-height: 56vh; left: 50%; top: 50%; transform: translate(-50%, -50%); }
    #asset.center-icon { width: clamp(176px, 20vw, 384px); height: clamp(176px, 20vw, 384px); left: 50%; top: 50%; transform: translate(-50%, -50%); }
    #asset.top-left-icon { width: clamp(136px, 12.5vw, 240px); height: clamp(136px, 12.5vw, 240px); left: 3vw; top: 5vh; }
    #asset.top-right-icon { width: clamp(136px, 12.5vw, 240px); height: clamp(136px, 12.5vw, 240px); right: 3vw; top: 5vh; }
    #raffle-stage { position: absolute; display: block; width: 30vw; left: 50%; top: 50%; transform: translate(-50%, -50%) scale(1); transform-origin: 50% 50%; opacity: 0; transition: opacity 120ms ease-out; pointer-events: none; }
    #raffle-stage.visible { opacity: 1; }
    #raffle-asset { display: block; width: 100%; height: auto; object-fit: contain; }
    #raffle-copy { position: absolute; left: 50%; top: calc(100% + clamp(2px, .4vh, 6px)); transform: translateX(-50%); width: 180%; box-sizing: border-box; padding: 4px 22px; border: 0; background: transparent; color: #fff; text-align: center; opacity: 0; transition: opacity 150ms ease-out,transform 180ms ease-out; font-family: "Malgun Gothic","Apple SD Gothic Neo",sans-serif; filter: drop-shadow(0 3px 2px rgba(5,22,48,.92)) drop-shadow(0 0 7px rgba(5,22,48,.72)); }
    #raffle-copy.visible { opacity: 1; transform: translateX(-50%) translateY(-4px); }
    #raffle-title { color: #ffc23a; font-size: clamp(22px,2.1vw,42px); font-weight: 900; letter-spacing: -.03em; text-shadow: 0 2px 0 #071c3d; }
    #raffle-primary { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(26px,2.6vw,50px); font-weight: 900; letter-spacing: -.04em; }
    #flashbang-stage { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
    #flashbang-stage.visible.soft { animation: flashbang-soft-recover 5000ms cubic-bezier(.14,.58,.32,1) both; }
    #flashbang-stage.visible.standard { animation: flashbang-standard-recover 5000ms cubic-bezier(.14,.58,.32,1) both; }
    #flashbang-stage.visible.strong { animation: flashbang-strong-recover 5000ms cubic-bezier(.14,.58,.32,1) both; }
    #flashbang-asset { display: block; width: 100%; height: 100%; object-fit: cover; }
    #effect-stage { position:absolute; inset:0; width:100%; height:100%; opacity:0; pointer-events:none; overflow:hidden; isolation:isolate; }
    #effect-stage.visible.water-splash { animation:water-splash-show 1750ms linear both; }
    #effect-stage.visible.fireworks { animation:fireworks-show 4100ms linear both; }
    #effect-asset { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:cover; }
    #water-runoff-asset { position:absolute; inset:-4%; display:none; width:108%; height:108%; object-fit:cover; opacity:0; z-index:3; }
    #water-refraction { position:absolute; inset:0; display:none; z-index:1; opacity:0; background:radial-gradient(ellipse at 48% 38%,rgba(205,247,255,.12),rgba(52,169,220,.07) 44%,rgba(2,63,126,.04) 72%,transparent 90%); backdrop-filter:blur(.65px) saturate(1.08); }
    #water-flow-canvas { position:absolute; inset:0; display:none; width:100%; height:100%; }
    #water-vfx-video { position:absolute; inset:0; display:none; width:100%; height:100%; object-fit:cover; z-index:4; }
    #fireworks-vfx-video { position:absolute; inset:0; display:none; width:100%; height:100%; object-fit:cover; z-index:4; }
    #effect-stage.water-splash #water-vfx-video { display:block; }
    #effect-stage.water-splash.water-complete #water-vfx-video { display:none; }
    #effect-stage.water-splash #effect-asset,
    #effect-stage.water-splash #water-runoff-asset,
    #effect-stage.water-splash #water-refraction,
    #effect-stage.water-splash #water-flow-canvas { display:none; }
    #effect-stage.fireworks #effect-asset { display:none; }
    #effect-stage.fireworks #fireworks-vfx-video { display:block; }
    @keyframes flashbang-soft-recover { 0%,8% { opacity:.68 } 35% { opacity:.50 } 68% { opacity:.20 } 100% { opacity:0 } }
    @keyframes flashbang-standard-recover { 0%,10% { opacity:.86 } 38% { opacity:.66 } 70% { opacity:.28 } 100% { opacity:0 } }
    @keyframes flashbang-strong-recover { 0%,13% { opacity:1 } 42% { opacity:.82 } 73% { opacity:.38 } 100% { opacity:0 } }
    @keyframes water-splash-show { 0% {opacity:0} 3%,88% {opacity:1} 100% {opacity:0} }
    @keyframes water-impact-burst { 0% {opacity:0;filter:blur(9px);transform:scale(.64) rotate(-2.5deg)} 8% {opacity:1;filter:blur(0);transform:scale(1.055) rotate(.35deg)} 22% {opacity:.96;transform:scale(1) rotate(0)} 55% {opacity:.56;filter:blur(.2px);transform:scale(1.018)} 100% {opacity:0;filter:blur(1.5px);transform:scale(1.07)} }
    @keyframes water-runoff-settle { 0% {opacity:0;clip-path:inset(0 0 86% 0);filter:blur(3px);transform:scale(1.025, .94)} 18% {opacity:.78;clip-path:inset(0 0 43% 0);filter:blur(.4px);transform:scale(1.01, .98)} 46% {opacity:.88;clip-path:inset(0);transform:scale(1,1.015)} 76% {opacity:.58;transform:scale(1.004,1.035)} 100% {opacity:0;filter:blur(1.2px);transform:scale(1.008,1.055)} }
    @keyframes water-refraction-pulse { 0% {opacity:0} 7% {opacity:.74} 34% {opacity:.36} 78% {opacity:.16} 100% {opacity:0} }
    @keyframes fireworks-show { 0% {opacity:0} 2%,94% {opacity:1} 100% {opacity:0} }
  </style>
</head>
<body>
  <img id="asset" alt="" draggable="false">
  <div id="raffle-stage"><img id="raffle-asset" alt="" draggable="false"><section id="raffle-copy" aria-live="polite"><div id="raffle-title"></div><div id="raffle-primary"></div></section></div>
  <div id="flashbang-stage"><img id="flashbang-asset" alt="" draggable="false"></div>
  <div id="effect-stage" data-document-revision="categorized-actions-v12"><div id="water-refraction"></div><img id="effect-asset" alt="" draggable="false"><video id="water-vfx-video" muted playsinline preload="auto" src="/overlay/builtin/water-splash-v4.webm?v=553531218503cf9d79963944900e82c6184eba87bf7e516e414a231b405f3775"></video><video id="fireworks-vfx-video" muted playsinline preload="auto" src="/overlay/builtin/photoreal-confetti-double-v5.webm?v=bcdcac2dbe0073af9fb7ea0fd59e5c7107fe6a66e32be11eb6260110573f8b9c"></video><img id="water-runoff-asset" alt="" draggable="false" src="/overlay/builtin/water-runoff-v2.png?v=d059b9e5d45fb638b764ea6c8cb3cb794490edc9c2a9587873fa5e1ec0c802ee"><canvas id="water-flow-canvas"></canvas></div>
  <script>
    const asset = document.getElementById('asset');
    const raffleStage = document.getElementById('raffle-stage');
    const raffleAsset = document.getElementById('raffle-asset');
    const raffleCopy = document.getElementById('raffle-copy');
    const raffleTitle = document.getElementById('raffle-title');
    const rafflePrimary = document.getElementById('raffle-primary');
    const flashbangStage = document.getElementById('flashbang-stage');
    const flashbangAsset = document.getElementById('flashbang-asset');
    const effectStage = document.getElementById('effect-stage');
    const effectAsset = document.getElementById('effect-asset');
    const waterRunoffAsset = document.getElementById('water-runoff-asset');
    const waterFlowCanvas = document.getElementById('water-flow-canvas');
    const waterVfxVideo = document.getElementById('water-vfx-video');
    const fireworksVfxVideo = document.getElementById('fireworks-vfx-video');
    let currentRevision = '';
    let loadedFlashbangRevision = '';
    let loadedEffectRevision = '';
    let activeAudio = null;
    let waterAnimationFrame = 0;
    let waterRunId = 0;
    function stopAudio() {
      if (!activeAudio) return;
      try { activeAudio.player.pause(); activeAudio.player.removeAttribute('src'); activeAudio.player.load(); } catch {}
      activeAudio = null;
    }
    function stopWaterAnimation() {
      waterRunId++;
      if (waterAnimationFrame) cancelAnimationFrame(waterAnimationFrame);
      waterAnimationFrame = 0;
      try { waterVfxVideo.pause(); waterVfxVideo.currentTime = 0; } catch {}
      effectStage.classList.remove('water-complete');
      const context = waterFlowCanvas.getContext('2d');
      if (context) context.clearRect(0, 0, waterFlowCanvas.width, waterFlowCanvas.height);
    }
    function stopFireworksAnimation() {
      try { fireworksVfxVideo.pause(); fireworksVfxVideo.currentTime = 0; } catch {}
    }
    function startFireworksAnimation() {
      stopFireworksAnimation();
      try { fireworksVfxVideo.currentTime = 0; void fireworksVfxVideo.play(); } catch {}
    }
    function hide() { asset.classList.remove('visible'); raffleStage.classList.remove('visible'); raffleCopy.classList.remove('visible'); flashbangStage.className = ''; effectStage.className = ''; stopWaterAnimation(); stopFireworksAnimation(); stopAudio(); }
    function reportAudio(descriptor, eventName) {
      if (!activeAudio || activeAudio.identity !== descriptor.identity) return;
      const url = '/overlay/audio-events/' + encodeURIComponent(descriptor.token) + '/' + eventName
        + '?revision=' + encodeURIComponent(descriptor.sha256)
        + '&presentationRevision=' + encodeURIComponent(descriptor.presentationRevision);
      fetch(url, { cache: 'no-store', keepalive: true }).catch(() => {});
    }
    function applyAudio(state) {
      if (typeof state.audioToken !== 'string'
          || typeof state.audioContentSha256 !== 'string'
          || !Number.isInteger(state.audioVolumePercent)
          || !Number.isInteger(state.audioPresentationRevision)
          || state.audioPresentationRevision !== state.revision) {
        stopAudio();
        return;
      }
      const identity = state.audioToken + ':' + state.audioContentSha256 + ':' + state.audioPresentationRevision;
      if (activeAudio && activeAudio.identity === identity) return;
      stopAudio();
      const descriptor = {
        identity,
        token: state.audioToken,
        sha256: state.audioContentSha256,
        presentationRevision: state.audioPresentationRevision,
        player: new Audio()
      };
      activeAudio = descriptor;
      descriptor.player.preload = 'auto';
      descriptor.player.volume = Math.max(0, Math.min(1, state.audioVolumePercent / 100));
      descriptor.player.addEventListener('playing', () => reportAudio(descriptor, 'started'), { once: true });
      descriptor.player.addEventListener('ended', () => reportAudio(descriptor, 'ended'), { once: true });
      descriptor.player.addEventListener('error', () => reportAudio(descriptor, 'failed'), { once: true });
      descriptor.player.src = '/overlay/audio/' + encodeURIComponent(descriptor.token)
        + '?revision=' + encodeURIComponent(descriptor.sha256)
        + '&presentationRevision=' + encodeURIComponent(descriptor.presentationRevision);
      descriptor.player.play().catch(() => reportAudio(descriptor, 'failed'));
    }
    function startWaterAnimation(identity) {
      stopWaterAnimation();
      effectStage.classList.remove('water-complete');
      waterVfxVideo.onended = () => effectStage.classList.add('water-complete');
      try {
        waterVfxVideo.playbackRate = 0.7;
        waterVfxVideo.currentTime = 0;
        void waterVfxVideo.play();
      } catch {}
      return;
      const runId = waterRunId;
      const context = waterFlowCanvas.getContext('2d', { alpha: true });
      if (!context) return;
      const width = Math.max(1, innerWidth);
      const height = Math.max(1, innerHeight);
      const pixelRatio = Math.min(1.5, devicePixelRatio || 1);
      waterFlowCanvas.width = Math.floor(width * pixelRatio);
      waterFlowCanvas.height = Math.floor(height * pixelRatio);
      waterFlowCanvas.style.width = width + 'px';
      waterFlowCanvas.style.height = height + 'px';
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      let seed = 2166136261;
      for (let index = 0; index < identity.length; index++) {
        seed ^= identity.charCodeAt(index);
        seed = Math.imul(seed, 16777619) >>> 0;
      }
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const sprayDroplets = Array.from({ length: 118 }, () => {
        const angle = random() * Math.PI * 2;
        const speed = width * (.12 + random() * .48);
        return {
          x: width * (.48 + (random() - .5) * .13),
          y: height * (.43 + (random() - .5) * .14),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - height * (.05 + random() * .18),
          gravity: height * (.55 + random() * .65),
          delay: random() * 170,
          radius: Math.max(2.2, width * (.0017 + random() * .0068)),
          stretch: 1.15 + random() * 2.7,
          opacity: .55 + random() * .4
        };
      });
      const lensBeads = Array.from({ length: 28 }, () => ({
        x: width * (.04 + random() * .92),
        y: height * (.04 + random() * .58),
        delay: 360 + random() * 740,
        speed: height * (.035 + random() * .12),
        radius: Math.max(5, width * (.003 + random() * .011)),
        phase: random() * Math.PI * 2,
        drift: width * (.002 + random() * .009) * (random() > .5 ? 1 : -1),
        opacity: .28 + random() * .38
      }));
      const startedAt = performance.now();
      const clamp = value => Math.max(0, Math.min(1, value));

      const draw = now => {
        if (runId !== waterRunId) return;
        const elapsed = now - startedAt;
        context.clearRect(0, 0, width, height);

        const shock = clamp(1 - elapsed / 620);
        if (shock > 0) {
          const bloom = context.createRadialGradient(
            width * .48,
            height * .43,
            0,
            width * .48,
            height * .43,
            width * (.16 + (1 - shock) * .42));
          bloom.addColorStop(0, 'rgba(225,252,255,' + (.2 * shock) + ')');
          bloom.addColorStop(.4, 'rgba(104,220,255,' + (.11 * shock) + ')');
          bloom.addColorStop(1, 'rgba(38,150,225,0)');
          context.fillStyle = bloom;
          context.fillRect(0, 0, width, height);
        }

        for (const droplet of sprayDroplets) {
          const seconds = (elapsed - droplet.delay) / 1000;
          if (seconds < 0 || seconds > 1.45) continue;
          const x = droplet.x + droplet.vx * seconds;
          const y = droplet.y + droplet.vy * seconds + .5 * droplet.gravity * seconds * seconds;
          if (y > height * 1.12) continue;
          const fade = 1 - clamp((seconds - .72) / .73);
          const velocityY = droplet.vy + droplet.gravity * seconds;
          const rotation = Math.atan2(velocityY, droplet.vx) + Math.PI / 2;
          context.save();
          context.translate(x, y);
          context.rotate(rotation);
          context.beginPath();
          context.ellipse(0, 0, droplet.radius, droplet.radius * droplet.stretch, 0, 0, Math.PI * 2);
          const dropGradient = context.createRadialGradient(
            -droplet.radius * .32,
            -droplet.radius * .52,
            droplet.radius * .08,
            0,
            0,
            droplet.radius * droplet.stretch);
          dropGradient.addColorStop(0, 'rgba(250,255,255,' + (.92 * droplet.opacity * fade) + ')');
          dropGradient.addColorStop(.26, 'rgba(150,232,255,' + (.8 * droplet.opacity * fade) + ')');
          dropGradient.addColorStop(.76, 'rgba(38,153,224,' + (.52 * droplet.opacity * fade) + ')');
          dropGradient.addColorStop(1, 'rgba(5,72,158,' + (.12 * droplet.opacity * fade) + ')');
          context.fillStyle = dropGradient;
          context.fill();
          context.restore();
        }

        const residueFade = 1 - clamp((elapsed - 2860) / 640);
        for (const bead of lensBeads) {
          const seconds = (elapsed - bead.delay) / 1000;
          if (seconds < 0 || residueFade <= 0) continue;
          const x = bead.x + Math.sin(seconds * 2.1 + bead.phase) * bead.drift;
          const y = bead.y + bead.speed * seconds * seconds;
          if (y > height * 1.08) continue;
          const alpha = bead.opacity * Math.min(1, seconds * 4) * residueFade;
          const beadGradient = context.createRadialGradient(
            x - bead.radius * .3,
            y - bead.radius * .42,
            bead.radius * .08,
            x,
            y,
            bead.radius * 1.12);
          beadGradient.addColorStop(0, 'rgba(255,255,255,' + (.72 * alpha) + ')');
          beadGradient.addColorStop(.2, 'rgba(184,239,255,' + (.52 * alpha) + ')');
          beadGradient.addColorStop(.72, 'rgba(61,168,222,' + (.28 * alpha) + ')');
          beadGradient.addColorStop(1, 'rgba(3,52,120,0)');
          context.beginPath();
          context.ellipse(x, y, bead.radius, bead.radius * (1.14 + Math.min(.8, seconds * .28)), 0, 0, Math.PI * 2);
          context.fillStyle = beadGradient;
          context.fill();
        }

        if (elapsed < 3500) waterAnimationFrame = requestAnimationFrame(draw);
        else {
          waterAnimationFrame = 0;
          context.clearRect(0, 0, width, height);
        }
      };
      waterAnimationFrame = requestAnimationFrame(draw);
    }
    function isRaffleAsset(assetKey) { return assetKey === 'raffle_ticket_granted' || assetKey === 'raffle_draw'; }
    function flashbangIntensity(assetKey) {
      if (assetKey === 'flashbang_soft') return 'soft';
      if (assetKey === 'flashbang_standard') return 'standard';
      if (assetKey === 'flashbang_strong') return 'strong';
      return '';
    }
    function visualEffectKind(assetKey) {
      if (assetKey === 'water_splash') return 'water-splash';
      if (assetKey === 'fireworks') return 'fireworks';
      if (assetKey === 'earthquake_audio') return 'audio-only';
      return '';
    }
    function placementClass(assetKey) {
      if (assetKey === 'mic_off_center') return 'center-icon';
      if (assetKey === 'mic_off_top_left') return 'top-left-icon';
      if (assetKey === 'mic_off_top_right') return 'top-right-icon';
      if (assetKey === 'mic_off_badge' || assetKey === 'mic_off_quiet') return 'center-icon';
      if (assetKey === 'raffle_ticket_granted' || assetKey === 'raffle_draw') return 'center-icon';
      return 'center-card';
    }
    function baseWidthVw(assetKey) {
      if (assetKey === 'mic_off') return 42;
      if (assetKey === 'mic_off_top_left' || assetKey === 'mic_off_top_right') return 12.5;
      if (assetKey === 'raffle_ticket_granted' || assetKey === 'raffle_draw') return 30;
      return 20;
    }
    function applyPresentation(state) {
      if (typeof state.presentationKind !== 'string') { raffleCopy.classList.remove('visible'); return; }
      raffleTitle.textContent = typeof state.presentationTitle === 'string' ? state.presentationTitle : '';
      rafflePrimary.textContent = typeof state.presentationPrimary === 'string' ? state.presentationPrimary : '';
      raffleCopy.classList.add('visible');
    }
    function applyPlacement(state) {
      asset.className = placementClass(state.assetKey);
      if (Number.isInteger(state.scalePercent)) {
        asset.style.width = (baseWidthVw(state.assetKey) * state.scalePercent / 100) + 'vw';
        asset.style.height = 'auto';
        asset.style.maxHeight = 'none';
      } else {
        asset.style.removeProperty('width');
        asset.style.removeProperty('height');
        asset.style.removeProperty('max-height');
      }
      if (Number.isInteger(state.positionX) && Number.isInteger(state.positionY)) {
        asset.style.left = (state.positionX / 100) + '%';
        asset.style.top = (state.positionY / 100) + '%';
        asset.style.right = 'auto';
        asset.style.transform = 'translate(-50%, -50%)';
      } else {
        asset.style.removeProperty('left');
        asset.style.removeProperty('top');
        asset.style.removeProperty('right');
        asset.style.removeProperty('transform');
      }
    }
    function applyRafflePlacement(state) {
      const scale = Number.isInteger(state.scalePercent) ? state.scalePercent / 100 : 1;
      raffleStage.style.width = baseWidthVw(state.assetKey) + 'vw';
      raffleStage.style.left = Number.isInteger(state.positionX) ? (state.positionX / 100) + '%' : '50%';
      raffleStage.style.top = Number.isInteger(state.positionY) ? (state.positionY / 100) + '%' : '50%';
      raffleStage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
    }
    async function refresh() {
      try {
        const response = await fetch('/overlay/state?documentRevision=categorized-actions-v12', { cache: 'no-store' });
        if (!response.ok) throw new Error('state unavailable');
        const state = await response.json();
        if (state.active === true && typeof state.assetToken === 'string') {
          const raffle = isRaffleAsset(state.assetKey);
          const flashbang = flashbangIntensity(state.assetKey);
          const visualEffect = visualEffectKind(state.assetKey);
          const targetAsset = raffle ? raffleAsset : flashbang ? flashbangAsset : visualEffect ? effectAsset : asset;
          const nextRevision = state.revision + ':' + state.assetToken + ':' + state.assetVersion + ':' + state.contentSha256 + ':' + state.assetKey + ':' + state.positionX + ':' + state.positionY + ':' + state.scalePercent;
          if (currentRevision !== nextRevision) {
            currentRevision = nextRevision;
            if (raffle) applyRafflePlacement(state); else if (!flashbang && !visualEffect) applyPlacement(state);
            if (flashbang) {
              loadedFlashbangRevision = '';
              flashbangStage.className = '';
              flashbangAsset.onload = () => {
                if (currentRevision !== nextRevision) return;
                loadedFlashbangRevision = nextRevision;
                flashbangStage.className = '';
                void flashbangStage.offsetWidth;
                flashbangStage.classList.add('visible', flashbang);
                applyAudio(state);
              };
              flashbangAsset.onerror = () => {
                if (currentRevision !== nextRevision) return;
                loadedFlashbangRevision = '';
                hide();
              };
            }
            if (visualEffect) {
              loadedEffectRevision = '';
              effectStage.className = '';
              if (visualEffect !== 'water-splash') stopWaterAnimation();
              if (visualEffect !== 'fireworks') stopFireworksAnimation();
              effectAsset.onload = () => {
                if (currentRevision !== nextRevision) return;
                loadedEffectRevision = nextRevision;
                effectStage.className = '';
                if (visualEffect !== 'audio-only') {
                  void effectStage.offsetWidth;
                  effectStage.classList.add('visible', visualEffect);
                }
                if (visualEffect === 'water-splash') startWaterAnimation(nextRevision);
                if (visualEffect === 'fireworks') startFireworksAnimation();
                applyAudio(state);
              };
              effectAsset.onerror = () => {
                if (currentRevision !== nextRevision) return;
                loadedEffectRevision = '';
                hide();
              };
            }
            targetAsset.src = '/overlay/assets/' + encodeURIComponent(state.assetToken)
              + '?revision=' + encodeURIComponent(state.contentSha256)
              + (flashbang || visualEffect ? '&presentationRevision=' + encodeURIComponent(state.revision) : '');
          }
          if (raffle) {
            asset.classList.remove('visible');
            flashbangStage.className = '';
            effectStage.className = '';
            stopWaterAnimation();
            stopFireworksAnimation();
            applyPresentation(state);
            raffleStage.classList.add('visible');
            applyAudio(state);
          } else if (flashbang) {
            asset.classList.remove('visible');
            raffleStage.classList.remove('visible');
            raffleCopy.classList.remove('visible');
            effectStage.className = '';
            stopWaterAnimation();
            stopFireworksAnimation();
            if (loadedFlashbangRevision === nextRevision) {
              flashbangStage.classList.add('visible', flashbang);
              applyAudio(state);
            } else {
              flashbangStage.className = '';
              stopAudio();
            }
          } else if (visualEffect) {
            asset.classList.remove('visible');
            raffleStage.classList.remove('visible');
            raffleCopy.classList.remove('visible');
            flashbangStage.className = '';
            if (visualEffect !== 'water-splash') stopWaterAnimation();
            if (visualEffect !== 'fireworks') stopFireworksAnimation();
            if (loadedEffectRevision === nextRevision) {
              if (visualEffect !== 'audio-only') effectStage.classList.add('visible', visualEffect);
              applyAudio(state);
            }
          } else {
            raffleStage.classList.remove('visible');
            raffleCopy.classList.remove('visible');
            flashbangStage.className = '';
            effectStage.className = '';
            stopWaterAnimation();
            stopFireworksAnimation();
            stopAudio();
            asset.classList.add('visible');
          }
        } else {
          hide();
        }
      } catch {
        hide();
      } finally {
        setTimeout(refresh, 100);
      }
    }
    asset.addEventListener('error', hide);
    raffleAsset.addEventListener('error', hide);
    refresh();
  </script>
</body>
</html>
""");

    private static readonly Lazy<byte[]> WaterRunoffBytes = new(
        static () =>
        {
            using var stream = typeof(ByeollogOverlayService).Assembly
                .GetManifestResourceStream(OverlayAssetCache.WaterRunoffResourceName);
            if (stream is null) return [];
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            return string.Equals(
                    sha256,
                    OverlayAssetCache.WaterRunoffContentSha256,
                    StringComparison.Ordinal)
                ? bytes
                : [];
        },
        LazyThreadSafetyMode.ExecutionAndPublication);

    private static readonly Lazy<byte[]> WaterSplashMotionBytes = new(
        static () =>
        {
            using var stream = typeof(ByeollogOverlayService).Assembly
                .GetManifestResourceStream(OverlayAssetCache.WaterSplashMotionResourceName);
            if (stream is null) return [];
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            return string.Equals(
                    sha256,
                    OverlayAssetCache.WaterSplashMotionContentSha256,
                    StringComparison.Ordinal)
                ? bytes
                : [];
        },
        LazyThreadSafetyMode.ExecutionAndPublication);

    private static readonly Lazy<byte[]> FireworksMotionBytes = new(
        static () =>
        {
            using var stream = typeof(ByeollogOverlayService).Assembly
                .GetManifestResourceStream(OverlayAssetCache.FireworksMotionResourceName);
            if (stream is null) return [];
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            return string.Equals(
                    sha256,
                    OverlayAssetCache.FireworksMotionContentSha256,
                    StringComparison.Ordinal)
                ? bytes
                : [];
        },
        LazyThreadSafetyMode.ExecutionAndPublication);

    private readonly CollectorStorage _storage;
    private readonly OverlayAssetCache _assetCache;
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _displayGate = new(1, 1);
    private readonly object _startGate = new();
    private readonly object _stateGate = new();
    private readonly object _previewGate = new();
    private readonly object _automationGate = new();
    private AutomationDisplaySession? _activeAutomation;
    private CancellationTokenSource? _previewCancellation;
    private int _automationDisplays;
    private Task? _acceptLoop;
    private long _revision;
    private OverlayAssetContent? _activeContent;
    private TimedMuteOverlayPlacement? _activePlacement;
    private RaffleOverlayPresentation? _activePresentation;
    private ActiveOverlayAudio? _activeAudio;
    private DateTimeOffset? _hideAtUtc;
    private long _stateRequests;
    private long _activeStateRequests;
    private long _assetRequests;
    private long _currentDocumentStateRequests;
    private long _currentDocumentActiveStateRequests;
    private long _lastStateRequestAtMs;
    private long _lastActiveStateRequestAtMs;
    private long _lastCurrentDocumentStateRequestAtMs;
    private long _lastCurrentDocumentActiveStateRequestAtMs;
    private long _lastAssetRequestAtMs;
    private bool _disposed;

    private sealed class ActiveOverlayAudio
    {
        public ActiveOverlayAudio(
            RaffleOverlayAudioContent content,
            long presentationRevision)
        {
            Content = content;
            PresentationRevision = presentationRevision;
            Token = Guid.NewGuid().ToString("D");
        }

        public RaffleOverlayAudioContent Content { get; }
        public long PresentationRevision { get; }
        public string Token { get; }
        public bool Requested { get; set; }
        public bool Started { get; set; }
        public bool Ended { get; set; }
        public string? FailureType { get; set; }
        public TaskCompletionSource<bool> StartedSignal { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Completion { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class AutomationDisplaySession
    {
        public AutomationDisplaySession(
            OverlayAssetContent content,
            TimedMuteOverlayPlacement? placement,
            int durationMs,
            CancellationToken serviceStop,
            bool requireObservedPresentation = false,
            bool requireCurrentDocument = false)
        {
            Content = content;
            Placement = placement;
            PendingDurationMs = durationMs;
            TotalDurationMs = durationMs;
            RequireObservedPresentation = requireObservedPresentation;
            RequireCurrentDocument = requireCurrentDocument;
            Stop = CancellationTokenSource.CreateLinkedTokenSource(serviceStop);
        }

        public OverlayAssetContent Content { get; set; }
        public TimedMuteOverlayPlacement? Placement { get; set; }
        public int PendingDurationMs { get; set; }
        public int TotalDurationMs { get; set; }
        public DateTimeOffset? HideAtUtc { get; set; }
        public bool Accepting { get; set; } = true;
        public bool RequireObservedPresentation { get; }
        public bool RequireCurrentDocument { get; }
        public CancellationTokenSource Stop { get; }
        public TaskCompletionSource<ByeollogOverlayDisplayEvidence> PresentationObserved { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> SideEffectStarted { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Completion { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public ByeollogOverlayService(
        CollectorStorage storage,
        OverlayAssetCache assetCache,
        int port = DefaultPort)
    {
        if (port is < 1_024 or > 65_535)
            throw new ArgumentOutOfRangeException(nameof(port));
        _storage = storage;
        _assetCache = assetCache;
        Port = port;
        _listener = new TcpListener(IPAddress.Loopback, port);
    }

    public int Port { get; }
    public string OverlayUrl => $"http://127.0.0.1:{Port}/overlay";
    public bool IsRunning => _acceptLoop is not null && !_acceptLoop.IsCompleted && !_stop.IsCancellationRequested;

    public bool TryResolveAsset(
        string assetKey,
        VNextOverlayAssetDescriptor? expectedAsset,
        out VNextOverlayAssetDescriptor resolvedAsset) =>
        _assetCache.TryResolve(assetKey, expectedAsset, out resolvedAsset);

    public bool TryStart()
    {
        lock (_startGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (IsRunning) return true;
            try
            {
                _listener.Start(16);
                _acceptLoop = Task.Run(() => AcceptLoopAsync(_stop.Token));
                _storage.Log($"별록 OBS 오버레이 시작 · {OverlayUrl}");
                return true;
            }
            catch (SocketException ex)
            {
                _storage.Log($"별록 OBS 오버레이 시작 실패 · port={Port} socket={ex.SocketErrorCode}");
                return false;
            }
        }
    }

    public async Task ShowAsync(
        string assetKey,
        int durationMs,
        VNextOverlayAssetDescriptor? expectedAsset,
        CancellationToken cancellationToken)
    {
        await ShowAsync(assetKey, durationMs, expectedAsset, placement: null, cancellationToken);
    }

    public async Task ShowTransientAsync(
        string assetKey,
        int durationMs,
        RaffleOverlayPresentation presentation,
        CancellationToken cancellationToken)
    {
        await ShowTransientAsync(assetKey, durationMs, presentation, placement: null, cancellationToken);
    }

    public async Task ShowTransientAsync(
        string assetKey,
        int durationMs,
        RaffleOverlayPresentation presentation,
        TimedMuteOverlayPlacement? placement,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(presentation);
        if (durationMs is < 1_000 or > 15_000) throw new ArgumentOutOfRangeException(nameof(durationMs));
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expected: null, out var resolvedAsset))
            throw new InvalidOperationException("오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");
        var content = _assetCache.Read(resolvedAsset);
        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _automationDisplays++;
            try { _previewCancellation?.Cancel(); } catch (ObjectDisposedException) { }
        }
        var acquired = false;
        try
        {
            await _displayGate.WaitAsync(cancellationToken);
            acquired = true;
            SetActive(content, placement, DateTimeOffset.UtcNow.AddMilliseconds(durationMs), presentation);
            await Task.Delay(durationMs, cancellationToken);
        }
        finally
        {
            if (acquired)
            {
                SetInactive();
                _displayGate.Release();
            }
            lock (_previewGate) _automationDisplays--;
        }
    }

    public async Task<ByeollogSynchronizedDisplayResult<T>> ShowObservedTransientAsync<T>(
        string assetKey,
        int durationMs,
        RaffleOverlayPresentation presentation,
        TimedMuteOverlayPlacement? placement,
        Func<CancellationToken, Task<T>> sideEffect,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(presentation);
        ArgumentNullException.ThrowIfNull(sideEffect);
        if (durationMs is < 1_000 or > 15_000) throw new ArgumentOutOfRangeException(nameof(durationMs));
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expected: null, out var resolvedAsset))
            throw new InvalidOperationException("추첨 오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");
        var content = _assetCache.Read(resolvedAsset);
        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _automationDisplays++;
            try { _previewCancellation?.Cancel(); } catch (ObjectDisposedException) { }
        }

        var acquired = false;
        try
        {
            await WaitBeforeDeadlineAsync(
                token => _displayGate.WaitAsync(token),
                cancellationToken,
                notAfterUtc);
            acquired = true;
            if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                throw new VNextActionExpiredException();
            var activeBefore = Interlocked.Read(ref _currentDocumentActiveStateRequests);
            var assetBefore = Interlocked.Read(ref _assetRequests);
            SetActive(
                content,
                placement,
                DateTimeOffset.UtcNow.AddMilliseconds(durationMs).AddSeconds(3),
                presentation);
            var evidence = await WaitForActivePresentationAsync(
                content.Descriptor.AssetKey,
                activeBefore,
                TimeSpan.FromSeconds(3),
                cancellationToken);
            await WaitForAssetRequestAsync(
                assetBefore,
                TimeSpan.FromSeconds(3),
                cancellationToken);
            UpdateHideAt(DateTimeOffset.UtcNow.AddMilliseconds(durationMs));

            // The audible side effect starts only after the current Browser Source
            // document has read this exact active presentation.
            var sideEffectTask = sideEffect(cancellationToken);
            var displayTask = Task.Delay(durationMs, cancellationToken);
            await Task.WhenAll(displayTask, sideEffectTask);
            return new ByeollogSynchronizedDisplayResult<T>(
                await sideEffectTask,
                evidence);
        }
        finally
        {
            if (acquired)
            {
                SetInactive();
                _displayGate.Release();
            }
            lock (_previewGate) _automationDisplays--;
        }
    }

    public async Task<ByeollogObservedAudioDisplayResult> ShowObservedAudioTransientAsync(
        string assetKey,
        int durationMs,
        RaffleOverlayPresentation presentation,
        TimedMuteOverlayPlacement? placement,
        RaffleOverlayAudioContent? audio,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(presentation);
        if (durationMs is < 1_000 or > 15_000)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        if (audio is not null)
            ValidateAudioContent(audio);
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expected: null, out var resolvedAsset))
            throw new InvalidOperationException("추첨 오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");
        var content = _assetCache.Read(resolvedAsset);
        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _automationDisplays++;
            try { _previewCancellation?.Cancel(); } catch (ObjectDisposedException) { }
        }

        var acquired = false;
        ActiveOverlayAudio? activeAudio = null;
        try
        {
            await WaitBeforeDeadlineAsync(
                token => _displayGate.WaitAsync(token),
                cancellationToken,
                notAfterUtc);
            acquired = true;
            if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                throw new VNextActionExpiredException();

            var activeBefore = Interlocked.Read(ref _currentDocumentActiveStateRequests);
            var assetBefore = Interlocked.Read(ref _assetRequests);
            var maximumHoldMs = checked(
                Math.Max(durationMs, BrowserAudioStartTimeoutMs + MaximumBrowserAudioPlaybackMs)
                + 1_000);
            activeAudio = SetActiveWithAudio(
                content,
                placement,
                DateTimeOffset.UtcNow.AddMilliseconds(maximumHoldMs + 3_000),
                presentation,
                audio);
            var evidence = await WaitForActivePresentationAsync(
                content.Descriptor.AssetKey,
                activeBefore,
                TimeSpan.FromSeconds(3),
                cancellationToken);
            await WaitForAssetRequestAsync(
                assetBefore,
                TimeSpan.FromSeconds(3),
                cancellationToken);
            UpdateHideAt(DateTimeOffset.UtcNow.AddMilliseconds(maximumHoldMs));

            var displayTask = Task.Delay(durationMs, cancellationToken);
            var audioTask = activeAudio is null
                ? Task.FromResult(new ByeollogOverlayAudioEvidence(
                    evidence.Revision,
                    false,
                    false,
                    false,
                    null))
                : WaitForBrowserAudioAsync(activeAudio, cancellationToken);
            await Task.WhenAll(displayTask, audioTask);
            return new ByeollogObservedAudioDisplayResult(evidence, await audioTask);
        }
        finally
        {
            if (acquired)
            {
                SetInactive();
                _displayGate.Release();
            }
            lock (_previewGate) _automationDisplays--;
        }
    }

    public async Task<ByeollogSynchronizedDisplayResult<T>> ShowSynchronizedAsync<T>(
        string assetKey,
        int durationMs,
        VNextOverlayAssetDescriptor? expectedAsset,
        TimedMuteOverlayPlacement? placement,
        Func<Action, CancellationToken, Task<T>> sideEffect,
        CancellationToken cancellationToken,
        bool requireCurrentDocument = false,
        DateTimeOffset? notAfterUtc = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(sideEffect);
        if (durationMs is < TimedMuteContract.MinimumDurationMs or > TimedMuteContract.MaximumDurationMs)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expectedAsset, out var resolvedAsset))
            throw new InvalidOperationException("오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");
        var content = _assetCache.Read(resolvedAsset);

        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _automationDisplays++;
            try { _previewCancellation?.Cancel(); }
            catch (ObjectDisposedException) { }
        }

        AutomationDisplaySession? session = null;
        var leader = false;
        try
        {
            while (true)
            {
                if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
                    throw new VNextActionExpiredException();
                Task<bool>? waitForPrevious = null;
                lock (_automationGate)
                {
                    if (_activeAutomation is null)
                    {
                        session = new AutomationDisplaySession(
                            content,
                            placement,
                            durationMs,
                            _stop.Token,
                            requireObservedPresentation: true,
                            requireCurrentDocument: requireCurrentDocument);
                        _activeAutomation = session;
                        leader = true;
                        break;
                    }

                    if (_activeAutomation.Accepting
                        && _activeAutomation.RequireObservedPresentation
                        && _activeAutomation.RequireCurrentDocument == requireCurrentDocument)
                    {
                        session = _activeAutomation;
                        if (session.TotalDurationMs > TimedMuteContract.MaximumAccumulatedDurationMs - durationMs)
                            throw new TimedMuteAccumulationLimitException();
                        session.PendingDurationMs += durationMs;
                        session.TotalDurationMs += durationMs;
                        session.Content = content;
                        session.Placement = placement;
                        if (session.HideAtUtc is not null)
                        {
                            session.HideAtUtc = session.HideAtUtc.Value.AddMilliseconds(durationMs);
                            SetActive(content, placement, session.HideAtUtc.Value);
                        }
                        break;
                    }

                    waitForPrevious = _activeAutomation.Completion.Task;
                }

                try
                {
                    await WaitBeforeDeadlineAsync(
                        async token => await waitForPrevious.WaitAsync(token),
                        cancellationToken,
                        notAfterUtc);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch { /* The next synchronized presentation starts after the old session closes. */ }
            }

            if (leader)
                _ = RunAutomationDisplayLeaderAsync(session);

            using var cancellationRegistration = leader
                ? cancellationToken.Register(
                    static value => ((CancellationTokenSource)value!).Cancel(),
                    session.Stop)
                : default;
            var evidence = await session.PresentationObserved.Task.WaitAsync(cancellationToken);
            if (notAfterUtc is not null && DateTimeOffset.UtcNow >= notAfterUtc.Value)
            {
                if (leader) session.Stop.Cancel();
                throw new VNextActionExpiredException();
            }
            Task<T> sideEffectTask;
            try
            {
                sideEffectTask = sideEffect(
                    () => session.SideEffectStarted.TrySetResult(true),
                    cancellationToken);
            }
            catch
            {
                if (leader) session.Stop.Cancel();
                throw;
            }
            if (leader)
            {
                _ = sideEffectTask.ContinueWith(
                    static (task, state) =>
                    {
                        var activeSession = (AutomationDisplaySession)state!;
                        if (!task.IsCompletedSuccessfully
                            || !activeSession.SideEffectStarted.Task.IsCompleted)
                        {
                            try { activeSession.Stop.Cancel(); }
                            catch (ObjectDisposedException) { }
                        }
                    },
                    session,
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
            try
            {
                await Task.WhenAll(sideEffectTask, session.Completion.Task);
            }
            catch
            {
                if (leader) session.Stop.Cancel();
                throw;
            }
            return new ByeollogSynchronizedDisplayResult<T>(
                await sideEffectTask,
                evidence);
        }
        finally
        {
            lock (_previewGate) _automationDisplays--;
        }
    }

    public async Task ShowAsync(
        string assetKey,
        int durationMs,
        VNextOverlayAssetDescriptor? expectedAsset,
        TimedMuteOverlayPlacement? placement,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (durationMs is < TimedMuteContract.MinimumDurationMs or > TimedMuteContract.MaximumDurationMs)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expectedAsset, out var resolvedAsset))
            throw new InvalidOperationException("오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");
        var content = _assetCache.Read(resolvedAsset);
        cancellationToken.ThrowIfCancellationRequested();

        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _automationDisplays++;
            try { _previewCancellation?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        try
        {
            AutomationDisplaySession session;
            var leader = false;
            while (true)
            {
                Task<bool>? waitForPrevious = null;
                lock (_automationGate)
                {
                    if (_activeAutomation is null)
                    {
                        session = new AutomationDisplaySession(content, placement, durationMs, _stop.Token);
                        _activeAutomation = session;
                        leader = true;
                        break;
                    }

                    if (_activeAutomation.Accepting && !_activeAutomation.RequireObservedPresentation)
                    {
                        session = _activeAutomation;
                        if (session.TotalDurationMs > TimedMuteContract.MaximumAccumulatedDurationMs - durationMs)
                            throw new TimedMuteAccumulationLimitException();
                        session.PendingDurationMs += durationMs;
                        session.TotalDurationMs += durationMs;
                        session.Content = content;
                        session.Placement = placement;
                        if (session.HideAtUtc is not null)
                        {
                            session.HideAtUtc = session.HideAtUtc.Value.AddMilliseconds(durationMs);
                            SetActive(content, placement, session.HideAtUtc.Value);
                        }
                        break;
                    }

                    waitForPrevious = _activeAutomation.Completion.Task;
                }

                try { await waitForPrevious.WaitAsync(cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch { /* 닫히는 세션이 gate를 반납하면 새 표시를 다시 시도합니다. */ }
            }

            using var cancellationRegistration = cancellationToken.Register(
                static value => ((CancellationTokenSource)value!).Cancel(),
                session.Stop);
            if (leader)
                await RunAutomationDisplayLeaderAsync(session);
            await session.Completion.Task;
        }
        finally
        {
            lock (_previewGate) _automationDisplays--;
        }
    }

    private async Task RunAutomationDisplayLeaderAsync(AutomationDisplaySession session)
    {
        var acquired = false;
        Exception? failure = null;
        try
        {
            await _displayGate.WaitAsync(session.Stop.Token);
            acquired = true;
            if (session.RequireObservedPresentation)
            {
                var activeBefore = session.RequireCurrentDocument
                    ? Interlocked.Read(ref _currentDocumentActiveStateRequests)
                    : Interlocked.Read(ref _activeStateRequests);
                lock (_automationGate)
                {
                    // Keep the state active while waiting for the Browser Source proof;
                    // the actual user-visible duration starts only with the side effect.
                    session.HideAtUtc = DateTimeOffset.UtcNow
                        .AddMilliseconds(session.TotalDurationMs)
                        .AddSeconds(3);
                    SetActive(session.Content, session.Placement, session.HideAtUtc.Value);
                }
                var evidence = await WaitForActivePresentationAsync(
                    session.Content.Descriptor.AssetKey,
                    activeBefore,
                    TimeSpan.FromSeconds(3),
                    session.Stop.Token,
                    session.RequireCurrentDocument);
                session.PresentationObserved.TrySetResult(evidence);
                await session.SideEffectStarted.Task.WaitAsync(session.Stop.Token);
                lock (_automationGate)
                {
                    session.HideAtUtc = DateTimeOffset.UtcNow.AddMilliseconds(session.TotalDurationMs);
                    UpdateHideAt(session.HideAtUtc.Value);
                }
            }
            else
            {
                lock (_automationGate)
                {
                    session.HideAtUtc = DateTimeOffset.UtcNow.AddMilliseconds(session.TotalDurationMs);
                    SetActive(session.Content, session.Placement, session.HideAtUtc.Value);
                }
                session.PresentationObserved.TrySetResult(new ByeollogOverlayDisplayEvidence(
                    Snapshot().Revision,
                    session.Content.Descriptor.AssetKey,
                    Interlocked.Read(ref _activeStateRequests),
                    Interlocked.Read(ref _activeStateRequests),
                    DateTimeOffset.UtcNow));
                session.SideEffectStarted.TrySetResult(true);
            }

            while (true)
            {
                int segmentDurationMs;
                lock (_automationGate)
                {
                    segmentDurationMs = session.PendingDurationMs;
                    session.PendingDurationMs = 0;
                }
                await Task.Delay(segmentDurationMs, session.Stop.Token);
                lock (_automationGate)
                {
                    if (session.PendingDurationMs == 0)
                    {
                        session.Accepting = false;
                        break;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            failure = ex;
        }
        finally
        {
            lock (_automationGate) session.Accepting = false;
            if (acquired)
            {
                SetInactive();
                _displayGate.Release();
            }
            lock (_automationGate)
            {
                if (ReferenceEquals(_activeAutomation, session))
                    _activeAutomation = null;
            }
        }

        if (failure is null)
            session.Completion.TrySetResult(true);
        else
        {
            session.PresentationObserved.TrySetException(failure);
            session.SideEffectStarted.TrySetResult(false);
            session.Completion.TrySetException(failure);
        }
    }

    public async Task<bool> PreviewAsync(
        string assetKey,
        int durationMs,
        VNextOverlayAssetDescriptor? expectedAsset,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (durationMs is < TimedMuteContract.MinimumDurationMs or > 10_000)
            throw new ArgumentOutOfRangeException(nameof(durationMs));
        cancellationToken.ThrowIfCancellationRequested();
        if (!_assetCache.TryResolve(assetKey, expectedAsset, out var resolvedAsset))
            throw new InvalidOperationException("오버레이 이미지가 준비되지 않았습니다.");
        if (!IsRunning && !TryStart())
            throw new InvalidOperationException("별록 오버레이 로컬 주소를 시작할 수 없습니다.");

        CancellationTokenSource preview;
        lock (_previewGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_automationDisplays > 0) return false;
            // 이미 시작된 미리보기를 새 요청이 취소하면 두 요청 모두 화면을
            // 보여주지 못할 수 있습니다. 중복 클릭은 즉시 실패시켜 첫 요청을
            // 그대로 마치게 하고, 실제 자동화만 미리보기를 선점합니다.
            if (_previewCancellation is not null) return false;
            preview = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
            _previewCancellation = preview;
        }

        var acquired = false;
        try
        {
            acquired = await _displayGate.WaitAsync(0, preview.Token);
            if (!acquired) return false;
            // WaitAsync가 완료된 직후 실제 자동화/종료 취소가 도착할 수 있으므로
            // 취소된 미리보기가 다시 화면을 활성화하지 못하게 마지막 경계를 둡니다.
            preview.Token.ThrowIfCancellationRequested();
            var content = _assetCache.Read(resolvedAsset);
            preview.Token.ThrowIfCancellationRequested();
            SetActive(content, placement: null, DateTimeOffset.UtcNow.AddMilliseconds(durationMs));
            try
            {
                await Task.Delay(durationMs, preview.Token);
                return true;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // 실제 자동화가 시작되면 미리보기를 즉시 양보하고, 서비스 종료도
                // 동일하게 처리합니다. 호출자가 취소한 경우만 취소 예외를 보존합니다.
                return false;
            }
            finally
            {
                SetInactive();
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        finally
        {
            if (acquired) _displayGate.Release();
            lock (_previewGate)
            {
                if (ReferenceEquals(_previewCancellation, preview))
                    _previewCancellation = null;
            }
            preview.Dispose();
        }
    }

    public ByeollogOverlaySnapshot Snapshot()
    {
        lock (_stateGate)
        {
            var active = _activeContent is not null
                && _hideAtUtc is not null
                && _hideAtUtc > DateTimeOffset.UtcNow;
            var asset = active ? _activeContent!.Descriptor : null;
            return new ByeollogOverlaySnapshot(
                _revision,
                active,
                asset?.AssetKey,
                asset?.AssetId,
                asset?.VersionNumber,
                asset?.ContentSha256,
                active ? _activePlacement?.XBasisPoints : null,
                active ? _activePlacement?.YBasisPoints : null,
                active ? _activePlacement?.ScalePercent : null,
                active ? _activePresentation?.Kind : null,
                active ? _activePresentation?.Title : null,
                active ? _activePresentation?.Primary : null,
                active ? _activePresentation?.Secondary : null,
                active ? _activePresentation?.WinnerNames : null,
                active ? _activeAudio?.Token : null,
                active ? _activeAudio?.Content.ContentSha256 : null,
                active ? _activeAudio?.Content.VolumePercent : null,
                active ? _activeAudio?.PresentationRevision : null,
                active ? _hideAtUtc : null);
        }
    }

    public ByeollogOverlayTelemetrySnapshot Telemetry()
    {
        var snapshot = Snapshot();
        var lastStateAtMs = Interlocked.Read(ref _lastStateRequestAtMs);
        var lastActiveAtMs = Interlocked.Read(ref _lastActiveStateRequestAtMs);
        var lastAssetAtMs = Interlocked.Read(ref _lastAssetRequestAtMs);
        return new ByeollogOverlayTelemetrySnapshot(
            snapshot.Revision,
            snapshot.Active,
            Interlocked.Read(ref _stateRequests),
            Interlocked.Read(ref _activeStateRequests),
            Interlocked.Read(ref _assetRequests),
            lastStateAtMs <= 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds(lastStateAtMs),
            lastActiveAtMs <= 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds(lastActiveAtMs),
            lastAssetAtMs <= 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds(lastAssetAtMs));
    }

    public async Task<bool> WaitForBrowserSourceAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool requireNewRequest = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(timeout));

        var baseline = Interlocked.Read(ref _stateRequests);
        var recentCutoff = DateTimeOffset.UtcNow - TimeSpan.FromSeconds(2);
        var lastStateAtMs = Interlocked.Read(ref _lastStateRequestAtMs);
        if (!requireNewRequest
            && lastStateAtMs > 0
            && DateTimeOffset.FromUnixTimeMilliseconds(lastStateAtMs) >= recentCutoff)
            return true;

        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Read(ref _stateRequests) > baseline)
                return true;
            await Task.Delay(100, cancellationToken);
        }
        return Interlocked.Read(ref _stateRequests) > baseline;
    }

    public async Task<bool> WaitForCurrentDocumentBrowserSourceAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool requireNewRequest = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(timeout));

        var baseline = Interlocked.Read(ref _currentDocumentStateRequests);
        var recentCutoff = DateTimeOffset.UtcNow - TimeSpan.FromSeconds(2);
        var lastStateAtMs = Interlocked.Read(ref _lastCurrentDocumentStateRequestAtMs);
        if (!requireNewRequest
            && lastStateAtMs > 0
            && DateTimeOffset.FromUnixTimeMilliseconds(lastStateAtMs) >= recentCutoff)
            return true;

        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Read(ref _currentDocumentStateRequests) > baseline)
                return true;
            await Task.Delay(100, cancellationToken);
        }
        return Interlocked.Read(ref _currentDocumentStateRequests) > baseline;
    }

    public async Task<bool> WaitForActiveAudioStartedAsync(
        string bindingKey,
        string contentSha256,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (string.IsNullOrWhiteSpace(bindingKey)
            || contentSha256.Length != 64
            || timeout <= TimeSpan.Zero
            || timeout > TimeSpan.FromSeconds(10))
            throw new ArgumentOutOfRangeException(nameof(timeout));

        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_stateGate)
            {
                if (_activeAudio is not null
                    && string.Equals(_activeAudio.Content.BindingKey, bindingKey, StringComparison.Ordinal)
                    && FixedTimeShaEquals(_activeAudio.Content.ContentSha256, contentSha256))
                {
                    if (_activeAudio.Started) return true;
                    if (_activeAudio.FailureType is not null) return false;
                }
            }
            await Task.Delay(50, cancellationToken);
        }

        lock (_stateGate)
        {
            return _activeAudio is not null
                && _activeAudio.Started
                && _activeAudio.FailureType is null
                && string.Equals(_activeAudio.Content.BindingKey, bindingKey, StringComparison.Ordinal)
                && FixedTimeShaEquals(_activeAudio.Content.ContentSha256, contentSha256);
        }
    }

    private async Task<ByeollogOverlayDisplayEvidence> WaitForActivePresentationAsync(
        string assetKey,
        long activeRequestsBefore,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool requireCurrentDocument = true)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var activeAfter = requireCurrentDocument
                ? Interlocked.Read(ref _currentDocumentActiveStateRequests)
                : Interlocked.Read(ref _activeStateRequests);
            if (activeAfter > activeRequestsBefore)
            {
                var observedAtMs = requireCurrentDocument
                    ? Interlocked.Read(ref _lastCurrentDocumentActiveStateRequestAtMs)
                    : Interlocked.Read(ref _lastActiveStateRequestAtMs);
                if (observedAtMs > 0)
                {
                    return new ByeollogOverlayDisplayEvidence(
                        Snapshot().Revision,
                        assetKey,
                        activeRequestsBefore,
                        activeAfter,
                        DateTimeOffset.FromUnixTimeMilliseconds(observedAtMs));
                }
            }
            await Task.Delay(50, cancellationToken);
        }
        throw new OverlayPresentationNotObservedException();
    }

    private async Task WaitForAssetRequestAsync(
        long assetRequestsBefore,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Read(ref _assetRequests) > assetRequestsBefore)
                return;
            await Task.Delay(50, cancellationToken);
        }
        throw new OverlayPresentationNotObservedException();
    }

    private static async Task WaitBeforeDeadlineAsync(
        Func<CancellationToken, Task> wait,
        CancellationToken cancellationToken,
        DateTimeOffset? notAfterUtc)
    {
        if (notAfterUtc is null)
        {
            await wait(cancellationToken);
            return;
        }

        var remaining = notAfterUtc.Value - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero)
            throw new VNextActionExpiredException();

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(remaining);
        try
        {
            await wait(deadline.Token);
        }
        catch (OperationCanceledException) when (
            !cancellationToken.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new VNextActionExpiredException();
        }
    }

    internal static bool IsMatchingLoopbackOverlayUrl(string candidate, string expected)
    {
        if (!Uri.TryCreate(candidate?.Trim(), UriKind.Absolute, out var candidateUri)
            || !Uri.TryCreate(expected?.Trim(), UriKind.Absolute, out var expectedUri)
            || !candidateUri.IsLoopback
            || !expectedUri.IsLoopback)
            return false;
        return string.Equals(candidateUri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && string.Equals(expectedUri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && candidateUri.Port == expectedUri.Port
            && string.Equals(
                candidateUri.AbsolutePath.TrimEnd('/'),
                expectedUri.AbsolutePath.TrimEnd('/'),
                StringComparison.OrdinalIgnoreCase);
    }

    private void SetActive(
        OverlayAssetContent content,
        TimedMuteOverlayPlacement? placement,
        DateTimeOffset hideAtUtc,
        RaffleOverlayPresentation? presentation = null)
    {
        lock (_stateGate)
        {
            _revision++;
            _activeContent = content;
            _activePlacement = placement;
            _activePresentation = presentation;
            _activeAudio = null;
            _hideAtUtc = hideAtUtc;
        }
    }

    private ActiveOverlayAudio? SetActiveWithAudio(
        OverlayAssetContent content,
        TimedMuteOverlayPlacement? placement,
        DateTimeOffset hideAtUtc,
        RaffleOverlayPresentation presentation,
        RaffleOverlayAudioContent? audio)
    {
        lock (_stateGate)
        {
            _revision++;
            _activeContent = content;
            _activePlacement = placement;
            _activePresentation = presentation;
            _activeAudio = audio is null ? null : new ActiveOverlayAudio(audio, _revision);
            _hideAtUtc = hideAtUtc;
            return _activeAudio;
        }
    }

    private void SetInactive()
    {
        lock (_stateGate)
        {
            _revision++;
            _activeContent = null;
            _activePlacement = null;
            _activePresentation = null;
            _activeAudio = null;
            _hideAtUtc = null;
        }
    }

    private static void ValidateAudioContent(RaffleOverlayAudioContent audio)
    {
        ArgumentNullException.ThrowIfNull(audio.Audio);
        if (audio.Audio.Length is < 44 or > ByeollogRaffleAudio.MaximumWinnerAudioBytes
            || audio.VolumePercent is < 1 or > 100
            || audio.BindingKey.Length is < 1 or > 200
            || audio.BindingKey.Any(char.IsControl)
            || audio.ContentSha256.Length != 64
            || !audio.ContentSha256.All(static character =>
                character is >= '0' and <= '9' or >= 'a' and <= 'f'))
            throw new InvalidDataException("OBS 오버레이 음성 입력 형식이 올바르지 않습니다.");
        var actualHash = SHA256.HashData(audio.Audio);
        if (!CryptographicOperations.FixedTimeEquals(
                actualHash,
                Convert.FromHexString(audio.ContentSha256)))
            throw new InvalidDataException("OBS 오버레이 음성 무결성이 올바르지 않습니다.");
        ByeollogRaffleAudio.ValidateWinnerAudioForPreflight(audio.Audio);
    }

    private async Task<ByeollogOverlayAudioEvidence> WaitForBrowserAudioAsync(
        ActiveOverlayAudio audio,
        CancellationToken cancellationToken)
    {
        try
        {
            await audio.StartedSignal.Task.WaitAsync(
                TimeSpan.FromMilliseconds(BrowserAudioStartTimeoutMs),
                cancellationToken);
        }
        catch (TimeoutException)
        {
            MarkAudioFailure(audio, "AudioStartTimeout");
        }

        if (audio.Started && audio.FailureType is null)
        {
            try
            {
                await audio.Completion.Task.WaitAsync(
                    TimeSpan.FromMilliseconds(MaximumBrowserAudioPlaybackMs),
                    cancellationToken);
            }
            catch (TimeoutException)
            {
                MarkAudioFailure(audio, "AudioEndTimeout");
            }
        }

        lock (_stateGate)
        {
            return new ByeollogOverlayAudioEvidence(
                audio.PresentationRevision,
                audio.Requested,
                audio.Started,
                audio.Ended,
                audio.FailureType);
        }
    }

    private void MarkAudioFailure(ActiveOverlayAudio audio, string failureType)
    {
        lock (_stateGate)
        {
            if (!ReferenceEquals(_activeAudio, audio) || audio.Ended) return;
            audio.FailureType ??= failureType;
            audio.StartedSignal.TrySetResult(false);
            audio.Completion.TrySetResult(false);
        }
    }

    private void UpdateHideAt(DateTimeOffset hideAtUtc)
    {
        lock (_stateGate)
        {
            if (_activeContent is not null)
                _hideAtUtc = hideAtUtc;
        }
    }

    private async Task AcceptLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (SocketException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            _ = HandleClientSafelyAsync(client, cancellationToken);
        }
    }

    private static async Task DrainHeadersAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var total = 0;
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line is null || line.Length == 0) return;
            total += line.Length;
            if (total > 16_384) throw new InvalidDataException("HTTP request headers are too large.");
        }
    }

    private async Task HandleClientSafelyAsync(TcpClient client, CancellationToken serverCancellationToken)
    {
        using (client)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(serverCancellationToken))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                var stream = client.GetStream();
                using var reader = new StreamReader(
                    stream,
                    Encoding.ASCII,
                    detectEncodingFromByteOrderMarks: false,
                    bufferSize: 2_048,
                    leaveOpen: true);
                var requestLine = await reader.ReadLineAsync(timeout.Token);
                if (requestLine is null || requestLine.Length > 2_048)
                {
                    await WriteResponseAsync(stream, 400, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Bad Request"), false, timeout.Token);
                    return;
                }
                await DrainHeadersAsync(reader, timeout.Token);

                var parts = requestLine.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
                var method = parts.Length == 3 ? parts[0] : "";
                var target = parts.Length == 3 ? parts[1] : "";
                var headOnly = string.Equals(method, "HEAD", StringComparison.Ordinal);
                if (!headOnly && !string.Equals(method, "GET", StringComparison.Ordinal))
                {
                    await WriteResponseAsync(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method Not Allowed"), false, timeout.Token);
                    return;
                }

                var path = target.Split('?', 2)[0];
                if (path == "/overlay")
                {
                    await WriteResponseAsync(stream, 200, "text/html; charset=utf-8", OverlayHtml, headOnly, timeout.Token);
                    return;
                }
                if (path == "/overlay/builtin/water-runoff-v2.png"
                    && WaterRunoffBytes.Value.Length > 0)
                {
                    await WriteResponseAsync(
                        stream,
                        200,
                        "image/png",
                        WaterRunoffBytes.Value,
                        headOnly,
                        timeout.Token);
                    return;
                }
                if (path == "/overlay/builtin/water-splash-v4.webm"
                    && WaterSplashMotionBytes.Value.Length > 0)
                {
                    await WriteResponseAsync(
                        stream,
                        200,
                        "video/webm",
                        WaterSplashMotionBytes.Value,
                        headOnly,
                        timeout.Token);
                    return;
                }
                if (path == "/overlay/builtin/photoreal-confetti-double-v5.webm"
                    && FireworksMotionBytes.Value.Length > 0)
                {
                    await WriteResponseAsync(
                        stream,
                        200,
                        "video/webm",
                        FireworksMotionBytes.Value,
                        headOnly,
                        timeout.Token);
                    return;
                }
                if (path == "/overlay/state")
                {
                    var snapshot = Snapshot();
                    if (!headOnly)
                    {
                        var currentDocument = HasCurrentDocumentRevision(target);
                        var requestedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        Interlocked.Increment(ref _stateRequests);
                        Interlocked.Exchange(ref _lastStateRequestAtMs, requestedAtMs);
                        if (currentDocument)
                        {
                            Interlocked.Increment(ref _currentDocumentStateRequests);
                            Interlocked.Exchange(ref _lastCurrentDocumentStateRequestAtMs, requestedAtMs);
                        }
                        if (snapshot.Active)
                        {
                            Interlocked.Increment(ref _activeStateRequests);
                            Interlocked.Exchange(ref _lastActiveStateRequestAtMs, requestedAtMs);
                            if (currentDocument)
                            {
                                Interlocked.Increment(ref _currentDocumentActiveStateRequests);
                                Interlocked.Exchange(ref _lastCurrentDocumentActiveStateRequestAtMs, requestedAtMs);
                            }
                        }
                    }
                    var body = JsonSerializer.SerializeToUtf8Bytes(snapshot, new JsonSerializerOptions
                    {
                        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                    });
                    await WriteResponseAsync(stream, 200, "application/json; charset=utf-8", body, headOnly, timeout.Token);
                    return;
                }
                const string assetPrefix = "/overlay/assets/";
                if (path.StartsWith(assetPrefix, StringComparison.Ordinal))
                {
                    var tokenText = path[assetPrefix.Length..];
                    var content = TryExactAssetBindingFromTarget(
                            target,
                            out var revision,
                            out var presentationRevision)
                        && Guid.TryParseExact(tokenText, "D", out var token)
                        ? ActiveContentForToken(
                            token.ToString("D"),
                            revision,
                            presentationRevision)
                        : null;
                    if (content is not null)
                    {
                        if (!headOnly)
                        {
                            Interlocked.Increment(ref _assetRequests);
                            Interlocked.Exchange(
                                ref _lastAssetRequestAtMs,
                                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                        }
                        var contentType = content.MimeType == "image/svg+xml"
                            ? "image/svg+xml; charset=utf-8"
                            : content.MimeType;
                        await WriteResponseAsync(stream, 200, contentType, content.Bytes, headOnly, timeout.Token);
                        return;
                    }
                }
                const string audioPrefix = "/overlay/audio/";
                if (path.StartsWith(audioPrefix, StringComparison.Ordinal))
                {
                    var tokenText = path[audioPrefix.Length..];
                    if (Guid.TryParseExact(tokenText, "D", out var token)
                        && TryExactAudioBindingFromTarget(
                            target,
                            out var audioRevision,
                            out var presentationRevision)
                        && TryGetActiveAudio(
                            token.ToString("D"),
                            audioRevision,
                            presentationRevision,
                            markRequested: !headOnly,
                            out var audioBytes))
                    {
                        await WriteResponseAsync(
                            stream,
                            200,
                            "audio/wav",
                            audioBytes!,
                            headOnly,
                            timeout.Token);
                        return;
                    }
                }
                const string audioEventPrefix = "/overlay/audio-events/";
                if (!headOnly && path.StartsWith(audioEventPrefix, StringComparison.Ordinal))
                {
                    var eventPath = path[audioEventPrefix.Length..].Split(
                        '/',
                        StringSplitOptions.RemoveEmptyEntries);
                    if (eventPath.Length == 2
                        && Guid.TryParseExact(eventPath[0], "D", out var token)
                        && eventPath[1] is "started" or "ended" or "failed"
                        && TryExactAudioBindingFromTarget(
                            target,
                            out var audioRevision,
                            out var presentationRevision)
                        && RecordAudioEvent(
                            token.ToString("D"),
                            audioRevision,
                            presentationRevision,
                            eventPath[1]))
                    {
                        await WriteResponseAsync(
                            stream,
                            200,
                            "application/json; charset=utf-8",
                            Encoding.UTF8.GetBytes("{\"ok\":true}"),
                            false,
                            timeout.Token);
                        return;
                    }
                }
                if (path == "/overlay/health")
                {
                    await WriteResponseAsync(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":true}"), headOnly, timeout.Token);
                    return;
                }

                await WriteResponseAsync(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"), headOnly, timeout.Token);
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (InvalidDataException) { }
            catch (SocketException) { }
        }
    }

    private static async Task WriteResponseAsync(
        NetworkStream stream,
        int statusCode,
        string contentType,
        byte[] body,
        bool headOnly,
        CancellationToken cancellationToken)
    {
        var reason = statusCode switch
        {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            405 => "Method Not Allowed",
            _ => "Error"
        };
        var headers = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {statusCode} {reason}\r\n" +
            $"Content-Type: {contentType}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Cache-Control: no-store, max-age=0\r\n" +
            "Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\r\n" +
            "Cross-Origin-Resource-Policy: same-origin\r\n" +
            "Referrer-Policy: no-referrer\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n\r\n");
        await stream.WriteAsync(headers, cancellationToken);
        if (!headOnly) await stream.WriteAsync(body, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static bool TryExactAssetBindingFromTarget(
        string target,
        out string revision,
        out long? presentationRevision)
    {
        revision = "";
        presentationRevision = null;
        var queryIndex = target.IndexOf('?');
        if (queryIndex < 0 || queryIndex == target.Length - 1) return false;
        var parts = target[(queryIndex + 1)..].Split('&', StringSplitOptions.None);
        if (parts.Length is < 1 or > 2
            || !parts[0].StartsWith("revision=", StringComparison.Ordinal)
            || (parts.Length == 2
                && !parts[1].StartsWith("presentationRevision=", StringComparison.Ordinal)))
            return false;
        try
        {
            revision = Uri.UnescapeDataString(parts[0]["revision=".Length..]);
            if (revision.Length != 64
                || !revision.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'))
                return false;
            if (parts.Length == 1) return true;
            var presentationText = Uri.UnescapeDataString(
                parts[1]["presentationRevision=".Length..]);
            if (!long.TryParse(
                    presentationText,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var parsedPresentationRevision)
                || parsedPresentationRevision <= 0)
                return false;
            presentationRevision = parsedPresentationRevision;
            return true;
        }
        catch (UriFormatException)
        {
            return false;
        }
    }

    private static bool TryExactAudioBindingFromTarget(
        string target,
        out string contentSha256,
        out long presentationRevision)
    {
        contentSha256 = "";
        presentationRevision = 0;
        var queryIndex = target.IndexOf('?');
        if (queryIndex < 0 || queryIndex == target.Length - 1) return false;
        var parts = target[(queryIndex + 1)..].Split('&', StringSplitOptions.None);
        if (parts.Length != 2
            || !parts[0].StartsWith("revision=", StringComparison.Ordinal)
            || !parts[1].StartsWith("presentationRevision=", StringComparison.Ordinal))
            return false;
        try
        {
            contentSha256 = Uri.UnescapeDataString(parts[0]["revision=".Length..]);
            var revisionText = Uri.UnescapeDataString(
                parts[1]["presentationRevision=".Length..]);
            return contentSha256.Length == 64
                && contentSha256.All(static character =>
                    character is >= '0' and <= '9' or >= 'a' and <= 'f')
                && long.TryParse(
                    revisionText,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out presentationRevision)
                && presentationRevision > 0;
        }
        catch (UriFormatException)
        {
            return false;
        }
    }

    private static bool HasCurrentDocumentRevision(string target)
    {
        var queryIndex = target.IndexOf('?');
        if (queryIndex < 0 || queryIndex == target.Length - 1) return false;
        var query = target[(queryIndex + 1)..];
        const string prefix = "documentRevision=";
        if (!query.StartsWith(prefix, StringComparison.Ordinal) || query.Contains('&')) return false;
        try
        {
            return string.Equals(
                Uri.UnescapeDataString(query[prefix.Length..]),
                DocumentRevision,
                StringComparison.Ordinal);
        }
        catch (UriFormatException)
        {
            return false;
        }
    }

    private OverlayAssetContent? ActiveContentForToken(
        string token,
        string revision,
        long? presentationRevision = null)
    {
        lock (_stateGate)
        {
            return _activeContent is not null
                && _hideAtUtc is not null
                && _hideAtUtc > DateTimeOffset.UtcNow
                && (presentationRevision is null || presentationRevision.Value == _revision)
                && string.Equals(
                    _activeContent.Descriptor.AssetId,
                    token,
                    StringComparison.OrdinalIgnoreCase)
                && string.Equals(
                    _activeContent.Descriptor.ContentSha256,
                    revision,
                    StringComparison.Ordinal)
                    ? _activeContent
                    : null;
        }
    }

    private bool TryGetActiveAudio(
        string token,
        string contentSha256,
        long presentationRevision,
        bool markRequested,
        out byte[]? audio)
    {
        lock (_stateGate)
        {
            audio = null;
            if (_activeAudio is null
                || _activeContent is null
                || _hideAtUtc is null
                || _hideAtUtc <= DateTimeOffset.UtcNow
                || _activeAudio.PresentationRevision != _revision
                || _activeAudio.PresentationRevision != presentationRevision
                || !string.Equals(_activeAudio.Token, token, StringComparison.OrdinalIgnoreCase)
                || !FixedTimeShaEquals(
                    _activeAudio.Content.ContentSha256,
                    contentSha256))
                return false;
            if (markRequested) _activeAudio.Requested = true;
            audio = _activeAudio.Content.Audio;
            return true;
        }
    }

    private bool RecordAudioEvent(
        string token,
        string contentSha256,
        long presentationRevision,
        string eventName)
    {
        lock (_stateGate)
        {
            if (_activeAudio is null
                || _activeContent is null
                || _hideAtUtc is null
                || _hideAtUtc <= DateTimeOffset.UtcNow
                || _activeAudio.PresentationRevision != _revision
                || _activeAudio.PresentationRevision != presentationRevision
                || !string.Equals(_activeAudio.Token, token, StringComparison.OrdinalIgnoreCase)
                || !FixedTimeShaEquals(
                    _activeAudio.Content.ContentSha256,
                    contentSha256))
                return false;

            if (eventName == "started")
            {
                if (!_activeAudio.Requested || _activeAudio.FailureType is not null)
                    return false;
                _activeAudio.Started = true;
                _activeAudio.StartedSignal.TrySetResult(true);
                return true;
            }
            if (eventName == "ended")
            {
                if (!_activeAudio.Requested
                    || !_activeAudio.Started
                    || _activeAudio.FailureType is not null)
                    return false;
                _activeAudio.Ended = true;
                _activeAudio.Completion.TrySetResult(true);
                return true;
            }
            if (eventName == "failed")
            {
                if (_activeAudio.Ended) return false;
                _activeAudio.FailureType ??= "BrowserAudioError";
                _activeAudio.StartedSignal.TrySetResult(false);
                _activeAudio.Completion.TrySetResult(false);
                return true;
            }
            return false;
        }
    }

    private static bool FixedTimeShaEquals(string left, string right)
    {
        if (left.Length != 64 || right.Length != 64) return false;
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(left),
                Convert.FromHexString(right));
        }
        catch (FormatException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        lock (_startGate)
        {
            if (_disposed) return;
            _disposed = true;
            _stop.Cancel();
            try { _listener.Stop(); } catch { }
        }
        lock (_previewGate)
        {
            try { _previewCancellation?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        SetInactive();
        try { _acceptLoop?.Wait(TimeSpan.FromSeconds(2)); } catch { }
        // ShowAsync/PreviewAsync의 finally가 아직 display gate를 Release할 수
        // 있습니다. 동기 Dispose에서 비동기 호출을 완전히 drain할 수 없으므로
        // 두 managed 동기화 객체는 여기서 조기 Dispose하지 않고 GC에 맡깁니다.
        // listener와 모든 작업은 위 cancellation으로 이미 종료됩니다.
    }
}
