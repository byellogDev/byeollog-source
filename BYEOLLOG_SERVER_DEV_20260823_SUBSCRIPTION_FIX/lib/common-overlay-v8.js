import {NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES} from './native-roulette.js';

const LOGICAL_WIDTH=460;
const LOGICAL_HEIGHT=450;
export const COMMON_OVERLAY_MAX_DISPLAY_NAME_GRAPHEMES=12;

export const COMMON_OVERLAY_V8_LAYOUT=Object.freeze({
  logicalWidth:LOGICAL_WIDTH,
  logicalHeight:LOGICAL_HEIGHT,
  cardWidth:420,
  artWidth:420,
  artHeight:166,
  cardTop:15,
  basePanelHeight:100,
  maxMessageHeight:154,
  maxDisplayNameGraphemes:COMMON_OVERLAY_MAX_DISPLAY_NAME_GRAPHEMES,
  maxResultNameGraphemes:NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES
});

export function computeCommonOverlayScale(viewportWidth,viewportHeight){
  const width=Math.max(1,Number(viewportWidth)||1);
  const height=Math.max(1,Number(viewportHeight)||1);
  return Math.min(width/LOGICAL_WIDTH,height/LOGICAL_HEIGHT);
}

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));
}

export function getCommonOverlayV8Html(nonce,{assets={},clientVersion='common-overlay-v8'}={}){
  const n=escapeHtml(nonce);
  const assetJson=JSON.stringify(assets).replace(/</g,'\\u003c');
  const versionJson=JSON.stringify(clientVersion).replace(/</g,'\\u003c');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="preload" href="https://fastly.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-7Bold.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="https://fastly.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-9Black.woff2" as="font" type="font/woff2" crossorigin>
<title>별록 공통 오버레이</title>
<style nonce="${n}">
@font-face{font-family:"Freesentation";src:url("https://fastly.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-7Bold.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"Freesentation";src:url("https://fastly.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-9Black.woff2") format("woff2");font-weight:700;font-style:normal;font-display:swap}
:root{--navy:#102746;--navy-2:#183858;--gold:#ffc247;--ink:#172a44;--paper:#fffefa;--muted:#66758b;--stage-scale:1;--alert-outline:-2px -2px 0 rgba(0,0,0,.88),0 -2px 0 rgba(0,0,0,.88),2px -2px 0 rgba(0,0,0,.88),-2px 0 0 rgba(0,0,0,.88),2px 0 0 rgba(0,0,0,.88),-2px 2px 0 rgba(0,0,0,.88),0 2px 0 rgba(0,0,0,.88),2px 2px 0 rgba(0,0,0,.88)}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;color:var(--ink);font-family:"Freesentation","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.root{position:fixed;inset:0;overflow:hidden;pointer-events:none}
.logicalStage{position:absolute;left:50%;top:50%;width:460px;height:450px;overflow:hidden;transform:translate(-50%,-50%) scale(var(--stage-scale));transform-origin:center}
.hidden{visibility:hidden!important;opacity:0!important}
.rouletteGroup{position:absolute;left:50%;top:15px;width:420px;height:420px;translate:-50% 0;visibility:hidden;opacity:0}
.rouletteGroup.visible{visibility:visible;opacity:1}
.rouletteGroup.entering{animation:cardEnter .48s cubic-bezier(.17,.82,.22,1) both}
.rouletteGroup.exiting{animation:cardExit .28s cubic-bezier(.4,0,.8,.2) both}
.rouletteCard{position:relative;display:flex;width:420px;height:420px;flex-direction:column;isolation:isolate}
.artShell{position:relative;z-index:2;width:420px;min-height:166px;flex:1;margin:0 auto;overflow:hidden;background:transparent;transform:translateZ(0)}
.presentation{display:block;width:100%;height:100%;object-fit:contain;object-position:center bottom;background:transparent}
.fallback{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(145deg,#f4f8ff,#eaf1fb)}
.fallbackWheel{position:relative;width:150px;aspect-ratio:1;border:7px solid #fff;border-radius:50%;background:conic-gradient(var(--navy) 0 12.5%,var(--gold) 12.5% 25%,#2f9d82 25% 37.5%,#f3d271 37.5% 50%,var(--navy) 50% 62.5%,var(--gold) 62.5% 75%,#2f9d82 75% 87.5%,#f3d271 87.5% 100%);box-shadow:0 0 0 4px var(--navy),0 12px 24px rgba(6,20,42,.24)}
.fallbackWheel:after{content:"";position:absolute;inset:39%;border:5px solid var(--navy);border-radius:50%;background:#fff}
.fallbackPointer{position:absolute;z-index:3;left:50%;top:5px;translate:-50% 0;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-top:25px solid var(--gold);filter:drop-shadow(0 2px 1px rgba(0,0,0,.28))}
.resultPanel{position:relative;z-index:3;width:420px;height:100px;flex:none;overflow:hidden;background:transparent;transition:height .36s cubic-bezier(.2,.72,.2,1)}
.metaLine{display:flex;align-items:center;justify-content:center;min-height:38px;padding:3px 12px 0;overflow:hidden;color:#fff;font-size:29px;font-weight:400;letter-spacing:-.025em;line-height:1.2;text-align:center;white-space:nowrap;text-shadow:var(--alert-outline)}
.metaLine.compact{font-size:25px}.metaLine.tight{font-size:22px}
.donorName,.donationSummary{min-width:0;overflow:hidden;color:var(--gold);font-weight:400;text-overflow:ellipsis}
.donationSummary{flex:0 0 auto}
.metaSuffix{flex:0 0 auto}
.seriesCounter{flex:0 0 auto;margin-left:.28em;color:#fff;font-variant-numeric:tabular-nums;font-weight:400}
.seriesCounter.hidden{display:none}
.seriesCounter.bump{animation:counterFlip .36s cubic-bezier(.18,.75,.24,1.18)}
.resultArea{position:relative;display:grid;height:62px;place-items:center;padding:0 20px 5px;transition:height .36s cubic-bezier(.2,.72,.2,1),padding .36s cubic-bezier(.2,.72,.2,1)}
.resultPanel.hasMessage .resultArea{height:50px;padding:0 20px 2px}
.resultReel{display:grid;width:100%;height:100%;place-items:center;overflow:hidden}
.slotValue{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;max-width:100%;overflow:visible;color:#fff;font-size:38px;font-weight:700;letter-spacing:-.035em;line-height:1.08;text-align:center;text-wrap:balance;word-break:keep-all;overflow-wrap:anywhere;text-shadow:var(--alert-outline)}
.slotValue.medium{font-size:32px}.slotValue.long{font-size:27px;line-height:1.08}
.resultPanel.hasMessage .slotValue.long{font-size:24px;line-height:1.04}
.slotValue.tick{animation:reelTick .115s cubic-bezier(.25,.65,.35,1)}
.slotValue .glyph{display:inline-block;white-space:pre;animation:glyphLand .54s cubic-bezier(.16,.84,.2,1.16) both;animation-delay:calc(var(--glyph-index)*14ms)}
.messageArea{height:0;overflow:hidden;opacity:0;transition:height .36s cubic-bezier(.2,.72,.2,1),opacity .24s ease}
.resultPanel.hasMessage .messageArea{height:var(--message-height,72px);opacity:1}
.messageText{display:grid;width:100%;height:100%;place-items:center;padding:2px 16px 4px;color:#fff;font-size:28px;font-weight:400;letter-spacing:-.025em;line-height:1.2;text-align:center;word-break:keep-all;overflow-wrap:anywhere;text-wrap:balance;text-shadow:var(--alert-outline)}
.messageText.short2{font-size:25px}.messageText.medium{font-size:22px}.messageText.long{font-size:20px;line-height:1.3}.messageText.xlong{font-size:18px;line-height:1.3}
.messageText.reveal{animation:messageReveal .48s cubic-bezier(.16,.82,.22,1) both}
.ceremony,.standaloneChat{position:absolute;left:50%;top:15px;translate:-50% 0;visibility:hidden;opacity:0}
.ceremony.visible,.standaloneChat.visible{visibility:visible;animation:cardEnter .48s cubic-bezier(.17,.82,.22,1) both}
.ceremony.exiting,.standaloneChat.exiting{animation:cardExit .28s cubic-bezier(.4,0,.8,.2) both}
.ceremonyCard{display:flex;width:420px;height:420px;flex-direction:column;justify-items:center}
.ceremonyImageWrap{position:relative;display:grid;width:420px;min-height:210px;flex:1;place-items:center;overflow:hidden;background:transparent}
.ceremonyImage{display:block;width:100%;height:100%;object-fit:contain;object-position:center bottom}
.ceremony.imageUnavailable .ceremonyImageWrap{display:none}.ceremony.imageUnavailable .ceremonyPanel{min-height:160px}
.ceremonyFallbackCount{position:absolute;left:50%;top:13%;z-index:2;translate:-50% 0;color:#f11b20;font-size:54px;font-weight:950;letter-spacing:-.04em;line-height:1;text-align:center;-webkit-text-stroke:5px #fff;paint-order:stroke fill;filter:drop-shadow(0 0 2px #000) drop-shadow(0 2px 1px #000)}
.ceremonyPanel{position:relative;z-index:2;display:flex;width:420px;min-height:105px;flex:none;flex-direction:column;overflow:hidden;background:transparent;color:#fff}
.ceremonyMetaLine{display:flex;align-items:center;justify-content:center;min-height:105px;flex:1;padding:4px 12px;color:#fff;font-size:29px;font-weight:400;letter-spacing:-.025em;line-height:1.2;text-align:center;white-space:nowrap;text-shadow:var(--alert-outline)}
.ceremonyPanel.hasMessage .ceremonyMetaLine{min-height:42px;flex:0 0 42px}
.ceremonyDonorName,.ceremonyDonationSummary{min-width:0;overflow:hidden;color:var(--gold);font-weight:400;text-overflow:ellipsis}
.ceremonyDonationSummary{flex:0 0 auto}
.ceremonyMetaLine.compact{font-size:24px}
.ceremonyMessageArea{display:none;height:0;place-items:center;padding:3px 18px 6px;transition:height .36s cubic-bezier(.2,.72,.2,1)}
.ceremonyPanel.hasMessage .ceremonyMessageArea{display:grid;height:var(--ceremony-message-height,56px)}
.ceremonyMessageText{display:grid;width:100%;height:100%;place-items:center;color:#fff;font-size:28px;font-weight:400;letter-spacing:-.025em;line-height:1.2;text-align:center;word-break:keep-all;overflow-wrap:anywhere;text-wrap:balance;text-shadow:var(--alert-outline)}
.ceremonyMessageText.short2{font-size:25px}.ceremonyMessageText.medium{font-size:22px}.ceremonyMessageText.long{font-size:20px;line-height:1.3}.ceremonyMessageText.xlong{font-size:18px;line-height:1.3}.ceremonyMessageText.reveal{animation:messageReveal .48s cubic-bezier(.16,.82,.22,1) both}
.standaloneChatBubble{position:relative;width:420px;margin:0;min-height:92px;display:grid;place-items:center;padding:17px 23px;border:2px solid rgba(21,42,68,.78);border-radius:16px;background:rgba(255,255,253,.98);box-shadow:0 17px 34px rgba(2,8,20,.3);color:var(--navy);font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;font-size:25px;font-weight:950;line-height:1.28;text-align:center;word-break:keep-all;overflow-wrap:anywhere}
.ready{display:none!important}
@keyframes cardEnter{0%{opacity:0;transform:translateY(24px) scale(.94)}68%{opacity:1;transform:translateY(-2px) scale(1.012)}100%{opacity:1;transform:none}}
@keyframes cardExit{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-10px) scale(.98)}}
@keyframes reelTick{0%{opacity:.16;transform:translateY(-38%)}100%{opacity:1;transform:none}}
@keyframes glyphLand{0%{opacity:0;transform:translateY(-.55em) scale(.82)}62%{opacity:1;transform:translateY(.04em) scale(1.07)}100%{opacity:1;transform:none}}
@keyframes messageReveal{0%{opacity:0;transform:translateY(-9px)}70%{opacity:1;transform:translateY(1px)}100%{opacity:1;transform:none}}
@keyframes counterFlip{0%{opacity:.2;transform:translateY(-65%)}70%{opacity:1;transform:translateY(8%)}100%{transform:none}}
@keyframes goldSweep{0%{translate:-240% 0;opacity:0}16%{opacity:1}72%{opacity:.8}100%{translate:700% 0;opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<main id="root" class="root" aria-live="polite">
  <div id="logicalStage" class="logicalStage">
    <section id="rouletteGroup" class="rouletteGroup" aria-label="룰렛 결과">
      <article id="rouletteCard" class="rouletteCard">
        <div class="artShell">
          <img id="presentation" class="presentation hidden" alt="룰렛 이미지">
          <div id="fallback" class="fallback hidden" aria-hidden="true">
            <div class="fallbackPointer"></div><div id="fallbackWheel" class="fallbackWheel"></div>
          </div>
        </div>
        <div id="resultPanel" class="resultPanel">
          <header id="metaLine" class="metaLine">
            <strong id="donorName" class="donorName"></strong>
            <span class="metaSuffix">님&nbsp;</span>
            <span id="donationSummary" class="donationSummary"></span>
            <span class="metaSuffix">&nbsp;감사합니다!</span>
            <span id="seriesCounter" class="seriesCounter hidden"></span>
          </header>
          <div id="resultArea" class="resultArea"><div class="resultReel"><strong id="slotValue" class="slotValue">룰렛 결과</strong></div></div>
          <div id="messageArea" class="messageArea"><span id="messageText" class="messageText"></span></div>
        </div>
      </article>
    </section>
    <section id="ceremony" class="ceremony" aria-label="후원 이미지">
      <article id="ceremonyCard" class="ceremonyCard">
        <div class="ceremonyImageWrap"><img id="ceremonyImage" class="ceremonyImage" alt="후원 세레모니"><strong id="ceremonyFallbackCount" class="ceremonyFallbackCount hidden" aria-hidden="true"></strong></div>
        <div id="ceremonyPanel" class="ceremonyPanel">
          <header id="ceremonyMetaLine" class="ceremonyMetaLine">
            <strong id="ceremonyDonorName" class="ceremonyDonorName"></strong>
            <span class="metaSuffix">님&nbsp;</span>
            <span id="ceremonyDonationSummary" class="ceremonyDonationSummary"></span>
            <span class="metaSuffix">&nbsp;감사합니다!</span>
          </header>
          <div id="ceremonyMessageArea" class="ceremonyMessageArea"><span id="ceremonyMessageText" class="ceremonyMessageText"></span></div>
        </div>
      </article>
    </section>
    <section id="standaloneChat" class="standaloneChat" aria-label="후원 메시지"><div id="standaloneChatBubble" class="standaloneChatBubble"></div></section>
  </div>
</main>
<div id="ready" class="ready" aria-hidden="true"></div>
<audio id="spinSound" preload="auto" src="/api/auth/soop/roulette-overlay/sound"></audio>
<script nonce="${n}">
(()=>{
'use strict';
const $=id=>document.getElementById(id),assets=${assetJson},clientVersion=${versionJson};
const MAX_DISPLAY_NAME_GRAPHEMES=${COMMON_OVERLAY_MAX_DISPLAY_NAME_GRAPHEMES},MAX_RESULT_NAME_GRAPHEMES=${NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const params=new URLSearchParams(location.hash.slice(1)),suppliedToken=params.get('token')||'';
if(suppliedToken)sessionStorage.setItem('byeollogOverlayToken',suppliedToken);
const token=suppliedToken||sessionStorage.getItem('byeollogOverlayToken')||'';
history.replaceState(null,'',location.pathname+location.search);
const clientId=sessionStorage.getItem('byeollogOverlayClient')||crypto.randomUUID();
sessionStorage.setItem('byeollogOverlayClient',clientId);
const playedStorage='byeollogPlayedOverlayCommandsV8';
function loadPlayed(){try{return new Set(JSON.parse(sessionStorage.getItem(playedStorage)||'[]'))}catch{return new Set()}}
const playedCommands=loadPlayed();
function remember(id){playedCommands.add(id);const recent=[...playedCommands].slice(-4096);playedCommands.clear();for(const value of recent)playedCommands.add(value);sessionStorage.setItem(playedStorage,JSON.stringify(recent))}
function wasPlayed(id){return playedCommands.has(id)}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function graphemes(value){const text=String(value??'');try{return [...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(part=>part.segment)}catch{return [...text]}}
function graphemeCount(value){return graphemes(value).length}
function limitDisplayName(value){const parts=graphemes(String(value||'').trim()||'시청자');return parts.length<=MAX_DISPLAY_NAME_GRAPHEMES?parts.join(''):parts.slice(0,MAX_DISPLAY_NAME_GRAPHEMES-1).join('')+'…'}
function limitResultName(value){return graphemes(String(value||'룰렛 결과').trim()||'룰렛 결과').slice(0,MAX_RESULT_NAME_GRAPHEMES).join('')}
async function withDeadline(promise,ms,message,onTimeout){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>{try{if(onTimeout)onTimeout()}catch{}reject(new Error(message))},ms)})])}finally{clearTimeout(timer)}}
async function fetchWithTimeout(url,options={},ms=8000){const controller=new AbortController();return withDeadline(fetch(url,{...options,signal:controller.signal}),ms,'overlay request timed out',()=>controller.abort())}
let busy=false,stopped=false,claimedOnce=false,slotTimer=null,audioContext=null,activeEventId=null,cardVisible=false,closeTimer=null,closeGeneration=0,lastPeekCommandId=null,lastMessage='';
let activeCeremonyEventId=null,ceremonyVisible=false,ceremonyCloseTimer=null,ceremonyCloseGeneration=0;
const abandonedEventIds=new Set();
function rememberAbandonedEvent(eventId){if(!eventId)return;abandonedEventIds.add(eventId);if(abandonedEventIds.size>64)abandonedEventIds.delete(abandonedEventIds.values().next().value)}
function abandonVisibleEventBefore(nextEventId){if(cardVisible&&activeEventId&&activeEventId!==nextEventId)rememberAbandonedEvent(activeEventId);if(ceremonyVisible&&activeCeremonyEventId&&activeCeremonyEventId!==nextEventId)rememberAbandonedEvent(activeCeremonyEventId)}

function applyStageScale(){const scale=Math.min(innerWidth/460,innerHeight/450);document.documentElement.style.setProperty('--stage-scale',String(Math.max(.01,scale)))}
addEventListener('resize',applyStageScale,{passive:true});applyStageScale();
function eventIdOf(command){const value=String(command&&command.payload&&command.payload.eventId||'');return UUID.test(value)?value.toLowerCase():''}
function seriesPosition(payload){const total=Math.max(1,Math.min(1000,Number(payload.presentationCount)||Number(payload.spinCount)||1)),rawIndex=payload.presentationIndex==null?payload.spinIndex:payload.presentationIndex,current=Math.max(1,Math.min(total,(Number(rawIndex)||0)+1));return {current,total}}
function fitTextClass(element,text,mediumAt,longAt){const length=graphemeCount(text);element.classList.toggle('medium',length>mediumAt&&length<=longAt);element.classList.toggle('long',length>longAt)}
function messageHeight(text){const length=graphemeCount(text);if(length<=22)return 32;if(length<=42)return 56;if(length<=70)return 80;if(length<=95)return 112;return 154}
function clearCloseTimer(){closeGeneration++;if(closeTimer){clearTimeout(closeTimer);closeTimer=null}}
function stopSlot(){if(slotTimer){clearInterval(slotTimer);slotTimer=null}}
function setPlainResult(text,tick){const value=limitResultName(text);const slot=$('slotValue');slot.textContent=value;fitTextClass(slot,value,9,12);if(tick){slot.classList.remove('tick');void slot.offsetWidth;slot.classList.add('tick')}}
function setWinner(text){const value=limitResultName(text),slot=$('slotValue');fitTextClass(slot,value,9,12);slot.replaceChildren();const glyphs=graphemes(value);glyphs.forEach((glyph,index)=>{const span=document.createElement('span');span.className='glyph';span.style.setProperty('--glyph-index',String(Math.min(index,20)));span.textContent=glyph;slot.append(span)});const panel=$('resultPanel');panel.classList.remove('landing');void panel.offsetWidth;panel.classList.add('landing');return 560+Math.min(Math.max(0,glyphs.length-1),20)*14}
function startSlot(items){stopSlot();const values=(Array.isArray(items)&&items.length?items:['보너스 상품','아봉 10초','다음 보상 2배','시크릿 단컷']).map(limitResultName);let index=0;setPlainResult(values[0],true);slotTimer=setInterval(()=>{index=(index+1)%values.length;setPlainResult(values[index],true)},118)}
function setSeriesCounter(payload){const position=seriesPosition(payload),counter=$('seriesCounter');counter.classList.toggle('hidden',position.total<=1);counter.textContent='['+position.current+']';counter.setAttribute('aria-label',position.current+' / '+position.total);counter.classList.remove('bump');void counter.offsetWidth;counter.classList.add('bump');return position}
function setMeta(payload){const donor=limitDisplayName(payload.actor&&payload.actor.name),type=String(payload.donationTypeLabel||payload.balloonTypeLabel||'별풍선').trim()||'별풍선',amount=Math.max(0,Number(payload.amount)||0),position=seriesPosition(payload),budget=graphemeCount(donor+type+String(amount)+'감사합니다');$('donorName').textContent=donor;$('donationSummary').textContent=type+' '+amount.toLocaleString()+'개';$('metaLine').classList.toggle('compact',position.total>1||budget>20);$('metaLine').classList.toggle('tight',budget>28)}
function showMessage(text){const normalized=String(text||'').trim();if(!normalized||normalized===lastMessage)return;lastMessage=normalized;const panel=$('resultPanel'),message=$('messageText'),height=messageHeight(normalized),length=graphemeCount(normalized);message.textContent=normalized;message.className='messageText';if(length>95)message.classList.add('xlong');else if(length>70)message.classList.add('long');else if(length>42)message.classList.add('medium');else if(length>22)message.classList.add('short2');panel.style.setProperty('--message-height',height+'px');panel.style.height=(100+height)+'px';panel.classList.add('hasMessage');void message.offsetWidth;message.classList.add('reveal')}
function clearMessage(){lastMessage='';lastPeekCommandId=null;$('messageText').textContent='';$('messageText').className='messageText';const panel=$('resultPanel');panel.classList.remove('hasMessage','landing');panel.style.height='100px';panel.style.removeProperty('--message-height')}
function clearCeremonyCloseTimer(){ceremonyCloseGeneration++;if(ceremonyCloseTimer){clearTimeout(ceremonyCloseTimer);ceremonyCloseTimer=null}}
function setCeremonyMeta(payload){const donor=limitDisplayName(payload.actor&&payload.actor.name),type=String(payload.donationTypeLabel||payload.balloonTypeLabel||'별풍선').trim()||'별풍선',amount=Math.max(0,Number(payload.amount)||0),budget=graphemeCount(donor+type+String(amount)+'감사합니다');$('ceremonyDonorName').textContent=donor;$('ceremonyDonationSummary').textContent=type+' '+amount.toLocaleString()+'개';$('ceremonyMetaLine').classList.toggle('compact',budget>20)}
function clearCeremonyMessage(){const panel=$('ceremonyPanel'),message=$('ceremonyMessageText');message.textContent='';message.className='ceremonyMessageText';panel.classList.remove('hasMessage');panel.style.removeProperty('--ceremony-message-height')}
function showCeremonyMessage(text){const normalized=String(text||'').trim();if(!normalized)return;const panel=$('ceremonyPanel'),message=$('ceremonyMessageText'),height=messageHeight(normalized),length=graphemeCount(normalized);message.textContent=normalized;message.className='ceremonyMessageText';if(length>95)message.classList.add('xlong');else if(length>70)message.classList.add('long');else if(length>42)message.classList.add('medium');else if(length>22)message.classList.add('short2');panel.style.setProperty('--ceremony-message-height',height+'px');panel.classList.add('hasMessage');void message.offsetWidth;message.classList.add('reveal')}
async function loadImage(image,url,label){if(!url)return false;image.onload=null;image.onerror=null;image.src=url;try{const loaded=image.decode?image.decode():new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject});await withDeadline(loaded,8000,label+' image timed out',()=>image.removeAttribute('src'));image.onload=null;image.onerror=null;return true}catch{image.onload=null;image.onerror=null;image.removeAttribute('src');return false}}
async function loadVisual(payload){const asset=assets[payload.overlayAssetKey]||{},colors=asset.colors||['#102746','#f6bd3b'],custom=payload.customImage&&payload.customImage.previewUrl||null,url=custom||asset.animationUrl||asset.previewUrl||'',image=$('presentation'),fallback=$('fallback');$('fallbackWheel').style.background='conic-gradient('+colors[0]+' 0 12.5%,'+colors[1]+' 12.5% 25%,#2f9d82 25% 37.5%,#f3d271 37.5% 50%,'+colors[0]+' 50% 62.5%,'+colors[1]+' 62.5% 75%,#2f9d82 75% 87.5%,#f3d271 87.5% 100%)';fallback.classList.add('hidden');image.classList.add('hidden');if(!await loadImage(image,url,'roulette')){fallback.classList.remove('hidden');return}image.classList.remove('hidden')}
function resetCeremony(){clearCeremonyCloseTimer();const ceremony=$('ceremony'),image=$('ceremonyImage');ceremony.classList.remove('visible','exiting');image.removeAttribute('src');$('ceremonyFallbackCount').classList.add('hidden');clearCeremonyMessage();activeCeremonyEventId=null;ceremonyVisible=false}
function hideOtherPresentations(){resetCeremony();$('standaloneChat').classList.remove('visible','exiting')}
async function openRoulette(command){const payload=command.payload,nextEventId=eventIdOf(command);abandonVisibleEventBefore(nextEventId);clearCloseTimer();hideOtherPresentations();activeEventId=nextEventId;cardVisible=true;clearMessage();setMeta(payload);setSeriesCounter(payload);setPlainResult('룰렛 결과',false);await loadVisual(payload);const group=$('rouletteGroup');group.classList.remove('exiting');group.classList.add('visible','entering');void group.offsetWidth;setTimeout(()=>group.classList.remove('entering'),520)}
function resetSpinSound(){const sound=$('spinSound');try{sound.pause();sound.currentTime=0}catch{}}
function playSpinSound(volume){const sound=$('spinSound');resetSpinSound();try{sound.volume=Math.max(0,Math.min(1,Number(volume==null?80:volume)/100));const attempt=sound.play();if(attempt&&typeof attempt.catch==='function')attempt.catch(()=>{})}catch{}}
async function hideRoulette(expectedGeneration=null){if(expectedGeneration==null)clearCloseTimer();else{closeTimer=null;if(expectedGeneration!==closeGeneration)return false}stopSlot();resetSpinSound();if(!cardVisible)return false;const group=$('rouletteGroup');group.classList.remove('entering');group.classList.add('exiting');await sleep(285);if(expectedGeneration!=null&&expectedGeneration!==closeGeneration){group.classList.remove('exiting');group.classList.add('visible');return false}group.classList.remove('visible','exiting');$('presentation').removeAttribute('src');$('presentation').classList.add('hidden');$('fallback').classList.add('hidden');clearMessage();activeEventId=null;cardVisible=false;return true}
async function hideCeremony(expectedGeneration=null){if(expectedGeneration==null)clearCeremonyCloseTimer();else{ceremonyCloseTimer=null;if(expectedGeneration!==ceremonyCloseGeneration)return false}if(!ceremonyVisible)return false;const view=$('ceremony');view.classList.add('exiting');await sleep(285);if(expectedGeneration!=null&&expectedGeneration!==ceremonyCloseGeneration){view.classList.remove('exiting');view.classList.add('visible');return false}view.classList.remove('visible','exiting');$('ceremonyImage').removeAttribute('src');clearCeremonyMessage();activeCeremonyEventId=null;ceremonyVisible=false;return true}
function scheduleCeremonyCloseAfter(delay){clearCeremonyCloseTimer();const expectedEvent=activeCeremonyEventId,expectedGeneration=ceremonyCloseGeneration;ceremonyCloseTimer=setTimeout(()=>{if(activeCeremonyEventId===expectedEvent)void hideCeremony(expectedGeneration)},delay)}

function fallbackSpeak(text,volume){return new Promise(resolve=>{try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ko-KR';utterance.rate=1.08;utterance.volume=Math.max(0,Math.min(1,Number(volume==null?80:volume)/100));let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};utterance.onend=done;utterance.onerror=done;speechSynthesis.speak(utterance);setTimeout(done,Math.min(30000,3000+String(text||'').length*220))}catch{resolve()}})}
function appendBytes(a,b){const joined=new Uint8Array(a.length+b.length);joined.set(a);joined.set(b,a.length);return joined}
function schedulePcm(state,bytes){const usable=bytes.length-(bytes.length%2);if(!usable)return;const samples=usable/2,buffer=state.context.createBuffer(1,samples,24000),channel=buffer.getChannelData(0),view=new DataView(bytes.buffer,bytes.byteOffset,usable);for(let i=0;i<samples;i++)channel[i]=view.getInt16(i*2,true)/32768;const source=state.context.createBufferSource();source.buffer=buffer;source.connect(state.gain);state.nextAt=Math.max(state.nextAt,state.context.currentTime+.1);source.start(state.nextAt);state.nextAt+=buffer.duration;state.played=true}
async function speak(command,text,volume){const normalized=String(text||'').trim();if(!normalized)return;if(!command.ttsAuthorization)return fallbackSpeak(normalized,volume);let streamed=false,deadline=null;const controller=new AbortController();try{deadline=setTimeout(()=>controller.abort(),Math.min(60000,15000+normalized.length*350));audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});await audioContext.resume();const gain=audioContext.createGain();gain.gain.value=Math.max(0,Math.min(1,Number(volume==null?80:volume)/100));gain.connect(audioContext.destination);const response=await fetch('/api/auth/soop/roulette-overlay/tts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({commandId:command.id,text:normalized,authorization:command.ttsAuthorization}),cache:'no-store',signal:controller.signal});if(!response.ok||!response.body)throw new Error('managed tts unavailable');const reader=response.body.getReader(),state={context:audioContext,gain,nextAt:audioContext.currentTime+.1,played:false};let pending=new Uint8Array(0),completed=false,streamError=null;while(true){const read=await reader.read();if(read.value&&read.value.length)pending=appendBytes(pending,read.value);let offset=0;while(pending.length-offset>=5){const view=new DataView(pending.buffer,pending.byteOffset+offset,pending.length-offset),type=view.getUint8(0),length=view.getUint32(1,false);if(length>2097152)throw new Error('tts frame too large');if(pending.length-offset<5+length)break;const frame=pending.slice(offset+5,offset+5+length);offset+=5+length;if(type===1){schedulePcm(state,frame);streamed=state.played}else if(type===2)completed=true;else if(type===3){try{streamError=JSON.parse(new TextDecoder().decode(frame))}catch{streamError={partial:state.played}}}}if(offset)pending=pending.slice(offset);if(read.done)break}if(state.played)await sleep(Math.max(0,(state.nextAt-audioContext.currentTime)*1000+80));if(!completed&&!state.played)throw new Error('managed tts incomplete');if(streamError){if(state.played){console.warn('[common-overlay] managed TTS ended after partial audio');return}throw new Error('managed tts failed')}}catch(error){if(streamed){console.warn('[common-overlay] managed TTS connection ended after partial audio');return}return fallbackSpeak(normalized,volume)}finally{clearTimeout(deadline)}}

async function ack(id,ok,error){let lastError;for(let attempt=0;attempt<5;attempt++){try{const response=await fetchWithTimeout('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({action:'ack',commandId:id,succeeded:ok,error:error||null}),cache:'no-store'},7000);if(response.ok)return;if(response.status===401||response.status===409)stopped=true;lastError=new Error('overlay acknowledgement failed')}catch(errorValue){lastError=errorValue}await sleep(220*Math.pow(2,attempt))}throw lastError||new Error('overlay acknowledgement failed')}
async function reportResultReveal(command){for(let attempt=0;attempt<4;attempt++){try{const response=await fetchWithTimeout('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({action:'result-revealed',commandId:command.id}),cache:'no-store'},5000);if(response.ok)return;if(response.status===401||response.status===409)return;if(response.status>=400&&response.status<500)return}catch{}await sleep(180*Math.pow(2,attempt))}console.warn('[common-overlay] roulette chat dry-run reveal was not recorded')}
async function heartbeat(){if(!token||stopped||!claimedOnce)return;try{const response=await fetchWithTimeout('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({action:'heartbeat',heartbeat:true}),cache:'no-store'},7000);if(response.status===401||response.status===409)stopped=true}catch{}}
setInterval(heartbeat,5000);
function prime(){try{$('spinSound').load();audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});void audioContext.resume()}catch{}}
document.addEventListener('click',prime,{passive:true});

function scheduleCloseAfter(delay){clearCloseTimer();const expectedEvent=activeEventId,expectedGeneration=closeGeneration;closeTimer=setTimeout(()=>{if(activeEventId===expectedEvent)void hideRoulette(expectedGeneration)},delay)}
async function peekFollowup(){const trackedEventId=cardVisible&&activeEventId?activeEventId:ceremonyVisible&&activeCeremonyEventId?activeCeremonyEventId:null;if(!token||stopped||!trackedEventId)return;try{const response=await fetchWithTimeout('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({action:'peek',eventId:trackedEventId}),cache:'no-store'},5000);if(!response.ok)return;const data=await response.json(),peek=data.peek;if(peek&&peek.eventId===trackedEventId&&peek.commandId!==lastPeekCommandId){lastPeekCommandId=peek.commandId;if(cardVisible&&activeEventId===trackedEventId){showMessage(peek.message);scheduleCloseAfter(15000)}else if(ceremonyVisible&&activeCeremonyEventId===trackedEventId){showCeremonyMessage(peek.message);scheduleCeremonyCloseAfter(15000)}}}catch{}}
setInterval(peekFollowup,450);

function finalCloseDelay(payload){let delay=3600;const occurredAt=Date.parse(payload.eventOccurredAt||'');if(Number.isFinite(occurredAt))delay=Math.max(3600,Math.min(15000,occurredAt+16200-Date.now()));return delay}
function scheduleFinalClose(payload){scheduleCloseAfter(finalCloseDelay(payload))}
function scheduleCeremonyFinalClose(payload){scheduleCeremonyCloseAfter(finalCloseDelay(payload))}
async function roulette(command){const payload=command.payload,eventId=eventIdOf(command),sameCard=cardVisible&&activeEventId&&activeEventId===eventId;clearCloseTimer();if(!sameCard)await openRoulette(command);else{setMeta(payload);setSeriesCounter(payload)}const position=seriesPosition(payload);startSlot(payload.rouletteItems);playSpinSound(payload.soundVolumePercent);await sleep(3000);resetSpinSound();stopSlot();const landingMs=setWinner(payload.resultText||'룰렛 결과');await sleep(landingMs);void reportResultReveal(command);await speak(command,payload.resultText||'',payload.ttsVolumePercent);if(position.current<position.total){scheduleCloseAfter(15000);await sleep(320);$('resultPanel').classList.remove('landing')}else scheduleFinalClose(payload)}
async function ceremony(command){const payload=command.payload,data=payload.ceremony||{},image=$('ceremonyImage'),fallbackCount=$('ceremonyFallbackCount'),nextEventId=eventIdOf(command);abandonVisibleEventBefore(nextEventId);await hideRoulette();hideOtherPresentations();let loaded=false,usingDefault=false;if(data.url){loaded=await loadImage(image,data.url,'ceremony');usingDefault=loaded&&data.source==='soop_default'}if(!loaded&&data.providerFallbackUrl)loaded=await loadImage(image,data.providerFallbackUrl,'provider fallback');if(!loaded&&data.defaultFallbackUrl){loaded=await loadImage(image,data.defaultFallbackUrl,'SOOP default');usingDefault=loaded}const fallbackAmount=Math.max(1,Number(payload.amount)||1).toLocaleString();fallbackCount.textContent=fallbackAmount;fallbackCount.dataset.count=fallbackAmount;fallbackCount.classList.toggle('hidden',!usingDefault||!loaded);activeCeremonyEventId=nextEventId;ceremonyVisible=true;lastPeekCommandId=null;clearCeremonyMessage();setCeremonyMeta(payload);const view=$('ceremony');view.classList.toggle('imageUnavailable',!loaded);view.classList.remove('exiting');view.classList.add('visible');scheduleCeremonyFinalClose(payload);await sleep(360)}
function standaloneChatText(payload){const message=String(payload.message||payload.ttsText||'').trim();if(payload.sourceKind==='followup_chat'){const seconds=Math.max(0,Math.round(Number(payload.elapsedSeconds)||0)),donor=limitDisplayName(payload.actor&&payload.actor.name);return '['+seconds+'초 전] '+donor+' : '+message}return message||String(payload.displayText||'').trim()}
async function chat(command){const payload=command.payload,eventId=eventIdOf(command);if(abandonedEventIds.has(eventId))return;const belongsToCard=cardVisible&&activeEventId&&activeEventId===eventId,belongsToCeremony=ceremonyVisible&&activeCeremonyEventId&&activeCeremonyEventId===eventId;if(belongsToCard){clearCloseTimer();showMessage(payload.message||payload.ttsText||'');await speak(command,payload.ttsText||payload.message||'',payload.ttsVolumePercent);await sleep(1050);await hideRoulette();return}if(belongsToCeremony){clearCeremonyCloseTimer();showCeremonyMessage(payload.message||payload.ttsText||'');await speak(command,payload.ttsText||payload.message||'',payload.ttsVolumePercent);await sleep(750);await hideCeremony();return}await hideRoulette();hideOtherPresentations();const view=$('standaloneChat');$('standaloneChatBubble').textContent=standaloneChatText(payload);view.classList.add('visible');await speak(command,payload.ttsText||payload.message||'',payload.ttsVolumePercent);await sleep(600);view.classList.add('exiting');await sleep(285);view.classList.remove('visible','exiting')}
async function play(command){busy=true;let succeeded=false,failure=null;try{if(command.kind==='roulette_spin')await roulette(command);else if(command.kind==='donation_ceremony')await ceremony(command);else if(command.kind==='donation_chat_tts')await chat(command);remember(command.id);succeeded=true}catch(error){failure=String(error&&error.message||error);await hideRoulette();await hideCeremony();await sleep(500)}finally{busy=false}await ack(command.id,succeeded,failure)}

let idlePollDelay=500;
async function poll(){if(stopped||busy)return setTimeout(poll,120);if(!token){$('ready').textContent='오버레이 주소를 다시 복사해주세요.';return}let nextDelay=idlePollDelay;try{const headers={Authorization:'Bearer '+token,'X-Byeollog-Overlay-Client':clientId},preferredEventId=cardVisible&&activeEventId?activeEventId:ceremonyVisible&&activeCeremonyEventId?activeCeremonyEventId:null;if(preferredEventId)headers['X-Byeollog-Overlay-Preferred-Event']=preferredEventId;const response=await fetchWithTimeout('/api/auth/soop/roulette-overlay/poll',{headers,cache:'no-store'},8000);if(response.status===401||response.status===409){stopped=true;return}if(response.status===423)return setTimeout(poll,2500);if(!response.ok)throw new Error('poll failed');const data=await response.json();claimedOnce=true;if(data.clientVersion&&data.clientVersion!==clientVersion){location.reload();return}if(data.command){idlePollDelay=350;nextDelay=120;if(wasPlayed(data.command.id))await ack(data.command.id,true);else await play(data.command)}else{idlePollDelay=Math.min(1500,Math.round(idlePollDelay*1.22+50));nextDelay=cardVisible||ceremonyVisible?180:idlePollDelay}}catch{idlePollDelay=Math.min(4000,Math.round(idlePollDelay*1.6+250));nextDelay=idlePollDelay}setTimeout(poll,nextDelay)}
poll();
})();
</script>
</body>
</html>`;
}
