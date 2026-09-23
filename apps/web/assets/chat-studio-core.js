
const presets={
"크림 말풍선":{bg:"#fff4d2",text:"#3c2a17",border:"#85531c",borderWidth:2,radius:14,shadow:true,align:"right",tail:"bottom-right"},
"어두운 유리":{bg:"#202634",text:"#f4f7ff",border:"#68738b",borderWidth:1,radius:18,shadow:true,align:"right",tail:"bottom-right"},
"민트 파스텔":{bg:"#e7fff6",text:"#173e34",border:"#67a897",borderWidth:2,radius:16,shadow:true,align:"left",tail:"bottom-left"},
"픽셀 게임":{bg:"#f8f1d8",text:"#28251c",border:"#2d2a24",borderWidth:3,radius:2,shadow:true,align:"left",tail:"none"},
"네온 방송":{bg:"#171429",text:"#fff8ff",border:"#b67cff",borderWidth:2,radius:12,shadow:true,align:"right",tail:"bottom-right"},
"심플 화이트":{bg:"#ffffff",text:"#20242a",border:"#d4d9e1",borderWidth:1,radius:10,shadow:false,align:"right",tail:"none"},
"파스텔 핑크":{bg:"#fff0f5",text:"#5d3141",border:"#e9a9c0",borderWidth:2,radius:20,shadow:true,align:"left",tail:"bottom-left"},
"만화 말풍선":{bg:"#fff7c8",text:"#111111",border:"#111111",borderWidth:3,radius:22,shadow:true,align:"right",tail:"bottom-right"}
};
const $=id=>document.getElementById(id);
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
let decorations=[],selected={type:null,id:null,instance:0},idSeq=1,dragState=null,snapEnabled=true;const MAGNET_PX=14;
let directGuideManuallyHidden=false,bubbleEditMode="wrap";
function keepDirectGuideVisible(){
 const g=$("directEditGuide");
 if(g&&!directGuideManuallyHidden)g.classList.remove("hidden")
}

const uid=()=>`layer_${idSeq++}`;
const snap=v=>snapEnabled?Math.round(v/4)*4:Math.round(v);
const selectedLayer=()=>selected.type==="layer"?decorations.find(x=>x.id===selected.id):null;

const ids=[
"align","maxWidth","gap","showNick","showPlatform","showBadge","tailEnabled","tailShape","tailAlignMode","tailEdgeOffset","tailEdgeOffsetEasy","tailX","tailWidth","tailHeight","tailBorderWidth","tailY","tailLinkColors","tailBg","tailBorder",
"borderWidth","padTop","padRight","padBottom","padLeft","radTL","radTR","radBR","radBL",
"fontSize","lineHeight","fontWeight","letterSpacing","textAlign","nickColor","nickSize","nickGap","nickBreak",
"frameWidth","frameHeight","frameX","frameY","patternPreset","patternColor","patternOpacity","patternSize","eventUseBubbleStyle","eventStripServiceSurface","eventBg","eventText","eventBorder","eventBorderWidth","eventRadius","donationWidth","donationCenter","adapter"
];

function val(id,fallback=0){const e=$(id);return e?+e.value:fallback}
function theme(){return{
 version:35,
 mode:document.body.classList.contains("advanced")?"advanced":"easy",
 layout:{alignment:$("align").value,maxWidth:val("maxWidth",420),gap:val("gap",8)},
 canvas:{width:val("frameWidth",720),height:val("frameHeight",620),x:val("frameX",40),y:val("frameY",30)},
 bubble:{
  background:$("bgAdv").value,textColor:$("textAdv").value,borderColor:$("borderAdv").value,borderWidth:val("borderWidth",2),
  radius:{tl:val("radTL",14),tr:val("radTR",14),br:val("radBR",14),bl:val("radBL",14)},
  padding:{top:val("padTop",9),right:val("padRight",14),bottom:val("padBottom",9),left:val("padLeft",14)},
  shadow:true
 },
 pattern:{
  preset:$("patternPreset")?$("patternPreset").value:"none",
  color:$("patternColor")?$("patternColor").value:"#e9a9c0",
  opacity:val("patternOpacity",26)/100,
  size:val("patternSize",18)
 },
 tail:{
  enabled:$("tailEnabled").checked && $("tailShape").value!=="none",
  shape:$("tailShape").value,
  alignMode:$("tailAlignMode").value,
  edgeOffset:val("tailEdgeOffset",18),
  xRatio:val("tailX",82),
  width:val("tailWidth",18),
  height:val("tailHeight",12),
  borderWidth:val("tailBorderWidth",2),
  yOffset:val("tailY",0),
  background:$("tailLinkColors").checked?$("bgAdv").value:$("tailBg").value,
  borderColor:$("tailLinkColors").checked?$("borderAdv").value:$("tailBorder").value,
  linkColors:$("tailLinkColors").checked
 },
 typography:{fontSize:val("fontSize",15),lineHeight:val("lineHeight",1.45),fontWeight:val("fontWeight",500),letterSpacing:val("letterSpacing",0),textAlign:$("textAlign").value},
 nickname:{visible:$("showNick").checked,color:$("nickColor").value,size:val("nickSize",12),gap:val("nickGap",4),break:$("nickBreak").checked},
 visibility:{platform:$("showPlatform").checked,badge:$("showBadge").checked},
 decorations:decorations.map(x=>({...x})),
 eventCards:{
  useBubbleStyle:$("eventUseBubbleStyle").checked,
  stripServiceSurface:$("eventStripServiceSurface").checked,
  background:$("eventUseBubbleStyle").checked?$("bgAdv").value:$("eventBg").value,
  textColor:$("eventUseBubbleStyle").checked?$("textAdv").value:$("eventText").value,
  borderColor:$("eventUseBubbleStyle").checked?$("borderAdv").value:$("eventBorder").value,
  borderWidth:$("eventUseBubbleStyle").checked?val("borderWidth",2):val("eventBorderWidth",2),
  radius:$("eventUseBubbleStyle").checked?val("radTL",14):val("eventRadius",14)
 },
 donation:{width:val("donationWidth",250),center:$("donationCenter").checked}
}}

function syncQuickButtonStates(){
 const align=$("align").value;
 document.querySelectorAll("[data-align]").forEach(b=>b.classList.toggle("active",b.dataset.align===align));

 const pt=val("padTop"),pb=val("padBottom"),pl=val("padLeft"),pr=val("padRight"),gap=val("gap");
 let density=null;
 if(pt===6&&pb===6&&pl===10&&pr===10&&gap===4)density="tight";
 else if(pt===9&&pb===9&&pl===14&&pr===14&&gap===8)density="normal";
 else if(pt===14&&pb===14&&pl===22&&pr===22&&gap===13)density="roomy";
 document.querySelectorAll("[data-density]").forEach(b=>b.classList.toggle("active",b.dataset.density===density));
}

function syncQuickAndAdvanced(){
 syncQuickButtonStates();
 $("bg").value=$("bgAdv").value;$("text").value=$("textAdv").value;$("border").value=$("borderAdv").value;
 if($("eventUseBubbleStyle").checked){
  $("eventBg").value=$("bgAdv").value;$("eventText").value=$("textAdv").value;$("eventBorder").value=$("borderAdv").value;
  $("eventBorderWidth").value=$("borderWidth").value;$("eventRadius").value=$("radTL").value
 }
 $("eventSeparateControls").style.opacity=$("eventUseBubbleStyle").checked?".45":"1";
 ["eventBg","eventText","eventBorder","eventBorderWidth","eventRadius"].forEach(id=>$(id).disabled=$("eventUseBubbleStyle").checked);
 if($("tailLinkColors").checked){$("tailBg").value=$("bgAdv").value;$("tailBorder").value=$("borderAdv").value}
 $("tailBg").disabled=$("tailLinkColors").checked;$("tailBorder").disabled=$("tailLinkColors").checked;
 $("tailEdgeOffsetEasy").value=$("tailEdgeOffset").value;
 $("tailFixedControls").classList.toggle("hidden",$("tailAlignMode").value==="free");
 $("tailFreeControls").classList.toggle("hidden",$("tailAlignMode").value!=="free");
 const sameRadius=[$("radTL").value,$("radTR").value,$("radBR").value,$("radBL").value].every(v=>v===$("radTL").value);
 $("radiusLinked").value=sameRadius?$("radTL").value:Math.round((val("radTL")+val("radTR")+val("radBR")+val("radBL"))/4)
}

function applyVars(){
 const t=theme(),r=document.documentElement;
 r.style.setProperty("--bubble-bg",t.bubble.background);r.style.setProperty("--bubble-text",t.bubble.textColor);r.style.setProperty("--bubble-border",t.bubble.borderColor);const pat=patternLayer(t);r.style.setProperty("--bubble-pattern-image",pat.image);r.style.setProperty("--bubble-pattern-size",pat.size);
 r.style.setProperty("--bubble-border-width",t.bubble.borderWidth+"px");
 r.style.setProperty("--bubble-radius-tl",t.bubble.radius.tl+"px");r.style.setProperty("--bubble-radius-tr",t.bubble.radius.tr+"px");r.style.setProperty("--bubble-radius-br",t.bubble.radius.br+"px");r.style.setProperty("--bubble-radius-bl",t.bubble.radius.bl+"px");
 r.style.setProperty("--bubble-pt",t.bubble.padding.top+"px");r.style.setProperty("--bubble-pr",t.bubble.padding.right+"px");r.style.setProperty("--bubble-pb",t.bubble.padding.bottom+"px");r.style.setProperty("--bubble-pl",t.bubble.padding.left+"px");
 r.style.setProperty("--sample-max-width",t.layout.maxWidth+"px");r.style.setProperty("--sample-gap",t.layout.gap+"px");r.style.setProperty("--donation-width",t.donation.width+"px");
 r.style.setProperty("--font-size",t.typography.fontSize+"px");r.style.setProperty("--line-height",t.typography.lineHeight);r.style.setProperty("--font-weight",t.typography.fontWeight);r.style.setProperty("--letter-spacing",t.typography.letterSpacing+"px");
 r.style.setProperty("--nick-color",t.nickname.color);r.style.setProperty("--nick-size",t.nickname.size+"px");r.style.setProperty("--nick-gap",t.nickname.gap+"px");
 r.style.setProperty("--tail-width",t.tail.width+"px");r.style.setProperty("--tail-height",t.tail.height+"px");
 r.style.setProperty("--tail-outline",t.tail.borderWidth+"px");r.style.setProperty("--tail-y",t.tail.yOffset+"px");
 r.style.setProperty("--tail-bg",t.tail.background);r.style.setProperty("--tail-border",t.tail.borderColor)
}
function setFrame(){
 const t=theme(),f=$("overlayFrame");
 const safeW=Math.max(240,t.canvas.width),safeH=Math.max(320,t.canvas.height);
 if(t.canvas.width!==safeW)$("frameWidth").value=safeW;
 if(t.canvas.height!==safeH)$("frameHeight").value=safeH;
 f.style.width=safeW+"px";f.style.height=safeH+"px";f.style.left=t.canvas.x+"px";f.style.top=t.canvas.y+"px"
}
function setPreview(){
 const t=theme();
 document.querySelectorAll(".sample-bubble").forEach(el=>el.style.textAlign=textAlignment(t));
 document.querySelectorAll(".sample-bubble").forEach(el=>{
  el.style.width=el.classList.contains("donation")?t.donation.width+"px":"";
 });
 document.querySelectorAll(".sample-row").forEach(r=>r.style.justifyContent=t.layout.alignment==="right"?"flex-end":"flex-start");
 document.querySelectorAll(".sample-bubble .nick").forEach(el=>el.style.display=t.nickname.visible?"inline":"none");
 document.querySelectorAll(".sample-bubble .platform").forEach(el=>el.style.display=t.visibility.platform?"inline":"none");
 document.querySelectorAll(".sample-bubble .badge").forEach(el=>el.style.display=t.visibility.badge?"inline":"none");
 document.querySelectorAll(".sample-bubble .meta").forEach(el=>{
  el.style.display=(t.nickname.visible||t.visibility.platform||(t.visibility.badge&&el.querySelector(".badge")))?(t.nickname.break?"block":"inline"):"none";
  el.style.margin=t.nickname.break?`0 0 ${t.nickname.gap}px 0`:`0 ${t.nickname.gap}px 0 0`;
 });
 document.querySelectorAll(".sample-bubble .msg").forEach(el=>el.style.display=t.nickname.break?"block":"inline");
 document.querySelectorAll(".donation").forEach(el=>{
  el.style.textAlign=t.donation.center?"center":textAlignment(t);
  el.classList.toggle("event-strip-surface",t.eventCards.stripServiceSurface);
  el.classList.toggle("event-separate-style",!t.eventCards.useBubbleStyle)
 });
 document.documentElement.style.setProperty("--event-bg",t.eventCards.background);
 document.documentElement.style.setProperty("--event-text",t.eventCards.textColor);
 document.documentElement.style.setProperty("--event-border",t.eventCards.borderColor);
 document.documentElement.style.setProperty("--event-border-width",t.eventCards.borderWidth+"px");
 document.documentElement.style.setProperty("--event-radius",t.eventCards.radius+"px");

}

function styleObj(el,obj){for(const[k,v]of Object.entries(obj))el.style[k]=v}
const ANCHOR_PARTS={
 "top-left":{v:"top",h:"left"},"top-center":{v:"top",h:"center"},"top-right":{v:"top",h:"right"},
 "center-left":{v:"center",h:"left"},"center":{v:"center",h:"center"},"center-right":{v:"center",h:"right"},
 "bottom-left":{v:"bottom",h:"left"},"bottom-center":{v:"bottom",h:"center"},"bottom-right":{v:"bottom",h:"right"}
};
function anchorParts(anchor){return ANCHOR_PARTS[anchor]||ANCHOR_PARTS["top-left"]}
const SELF_FACTOR_X={left:0,center:.5,right:1};
const SELF_FACTOR_Y={top:0,center:.5,bottom:1};
function smartAxisStyle(axis,target,self,offset,ratio,tf){
 const isX=axis==="x",propStart=isX?"left":"top",propEnd=isX?"right":"bottom",translate=isX?"translateX":"translateY";
 const selfFactor=(isX?SELF_FACTOR_X:SELF_FACTOR_Y)[self]??.5;
 if(target==="free"){
  const r=ratio??50;
  if(selfFactor)tf.push(`${translate}(${-selfFactor*100}%)`);
  return{[propStart]:r+"%"}
 }
 if(target==="left"||target==="top"){
  if(selfFactor)tf.push(`${translate}(${-selfFactor*100}%)`);
  return{[propStart]:(offset||0)+"px"}
 }
 if(target==="right"||target==="bottom"){
  if(selfFactor!==1)tf.push(`${translate}(${(1-selfFactor)*100}%)`);
  return{[propEnd]:(offset||0)+"px"}
 }
 // center target
 // left/top:50% points to the element START edge.
 // Shift back by the self-anchor fraction so the selected self point
 // lands exactly on the target center.
 const shift=-selfFactor*100;
 if(shift)tf.push(`${translate}(${shift}%)`);
 return{[propStart]:`calc(50% + ${offset||0}px)`}
}
function anchorStyle(l){
 const st={width:l.width+"px"},tf=[],mode=l.positionMode||"smart";
 if(mode==="smart"){
  Object.assign(st,smartAxisStyle("x",l.xTarget||"left",l.xSelf||"left",l.xOffset||0,l.xRatio??0,tf));
  Object.assign(st,smartAxisStyle("y",l.yTarget||"center",l.ySelf||"center",l.yOffset||0,l.yRatio??50,tf));
 }else if(mode==="ratio"){
  st.left=(l.xRatio??0)+"%";st.top=(l.yRatio??50)+"%";tf.push("translateX(-50%)","translateY(-50%)")
 }else{
  const p=anchorParts(l.anchor);
  if(p.h==="left")st.left=l.offsetX+"px";else if(p.h==="right")st.right=l.offsetX+"px";else{st.left=`calc(50% + ${l.offsetX}px)`;tf.push("translateX(-50%)")}
  if(p.v==="top")st.top=l.offsetY+"px";else if(p.v==="bottom")st.bottom=l.offsetY+"px";else{st.top=`calc(50% + ${l.offsetY}px)`;tf.push("translateY(-50%)")}
 }
 if(tf.length)st.transform=tf.join(" ");
 return st
}
function clearLayers(){document.querySelectorAll(".deco-layer,.deco-resize").forEach(el=>el.remove())}
function clearTailParts(){document.querySelectorAll(".tail-part,.tail-resize").forEach(el=>el.remove())}
function positionTailResizeHandle(handle,tail,bubble){
 const br=bubble.getBoundingClientRect(),tr=tail.getBoundingClientRect();
 handle.style.left=(tr.right-br.left-7)+"px";handle.style.top=(tr.bottom-br.top-7)+"px"
}
function effectiveTailSide(t){
 if(t.tail.alignMode==="left"||t.tail.alignMode==="right")return t.tail.alignMode;
 if(t.tail.alignMode==="auto")return t.layout.alignment==="right"?"right":"left";
 return"free"
}
function applyTailPositionStyle(tail,t){
 const side=effectiveTailSide(t);
 ["left","right","top","bottom","transform"].forEach(k=>tail.style[k]="");
 tail.style.width=t.tail.width+"px";tail.style.height=t.tail.height+"px";
 tail.classList.toggle("tail-soft",t.tail.shape==="soft");
 tail.classList.toggle("tail-none",!t.tail.enabled||t.tail.shape==="none");

 if(side==="left"){
  tail.style.left=t.tail.edgeOffset+"px";
  tail.style.top=`calc(100% + ${t.tail.yOffset}px)`;
  tail.style.transform="translate(-50%,-2px)";
 }else if(side==="right"){
  tail.style.right=t.tail.edgeOffset+"px";
  tail.style.top=`calc(100% + ${t.tail.yOffset}px)`;
  tail.style.transform="translate(50%,-2px)";
 }else{
  tail.style.left=t.tail.xRatio+"%";
  tail.style.top=`calc(100% + ${t.tail.yOffset}px)`;
  tail.style.transform="translate(-50%,-2px)"
 }
}
function renderTailParts(){
 clearTailParts();const t=theme();if(!t.tail.enabled||t.tail.shape==="none")return;
 [...document.querySelectorAll(".sample-bubble")].forEach((bubble,n)=>{
  const tail=document.createElement("div"),isSelected=selected.type==="tail"&&selected.instance===n;
  tail.className="tail-part"+(isSelected?" selected":"");tail.dataset.instance=n;
  applyTailPositionStyle(tail,t);
  tail.addEventListener("pointerdown",startTailDrag);
  tail.addEventListener("click",e=>{e.stopPropagation();selectTail(n)});
  bubble.appendChild(tail);
  if(isSelected){
   const h=document.createElement("div");h.className="tail-resize";h.dataset.instance=n;
   h.addEventListener("pointerdown",startTailResize);bubble.appendChild(h);positionTailResizeHandle(h,tail,bubble)
  }
 })
}
function positionResizeHandle(h,img,target){const tr=target.getBoundingClientRect(),ir=img.getBoundingClientRect();h.style.left=(ir.right-tr.left-7)+"px";h.style.top=(ir.bottom-tr.top-7)+"px"}
function renderLayers(){
 clearLayers();const bubbles=[...document.querySelectorAll(".sample-bubble")],frame=$("overlayFrame");
 decorations.filter(d=>d.visible!==false).forEach((l,idx)=>{
  const targets=l.scope==="bubble"?bubbles:[frame];
  targets.forEach((target,n)=>{
   const isSelected=selected.type==="layer"&&selected.id===l.id&&selected.instance===n;
   const isPeer=selected.type==="layer"&&selected.id===l.id&&!isSelected;
   const img=document.createElement("img");
   img.className="deco-layer"+(isSelected?" selected":"")+(isPeer?" template-peer":"");
   img.src=l.dataUrl;img.alt=l.name;img.dataset.layerId=l.id;img.dataset.instance=n;img.style.zIndex=20+idx;styleObj(img,anchorStyle(l));
   img.addEventListener("pointerdown",startLayerDrag);
   img.addEventListener("click",e=>{e.stopPropagation();selectLayer(l.id,n)});
   target.appendChild(img);
   if(isSelected){
    const h=document.createElement("div");h.className="deco-resize";h.dataset.layerId=l.id;h.dataset.instance=n;
    h.addEventListener("pointerdown",startLayerResize);target.appendChild(h);positionResizeHandle(h,img,target)
   }
  })
 })
}
function esc(s){return String(s||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function dirKo(v){
 return({
  left:"왼쪽",center:"가운데",right:"오른쪽",
  top:"위",bottom:"아래",free:"자유"
 })[v]||v
}
function anchorKo(v){
 const map={
  "top-left":"좌측 상단","top-center":"상단 가운데","top-right":"우측 상단",
  "center-left":"좌측 가운데","center":"정가운데","center-right":"우측 가운데",
  "bottom-left":"좌측 하단","bottom-center":"하단 가운데","bottom-right":"우측 하단"
 };
 return map[v]||v
}

function renderModalLayerList(){
 const wrap=$("modalLayerList"), empty=$("modalLayerEmpty");
 if(!wrap)return;
 wrap.innerHTML="";
 const has=decorations.length>0;
 if(empty) empty.classList.toggle("hidden",has);
 if(!has)return;
 decorations.slice().reverse().forEach(l=>{
  const item=document.createElement("button");
  item.type="button";
  item.className="modal-layer-item"+(selected.type==="layer"&&selected.id===l.id?" selected":"");
  item.innerHTML=`<img src="${l.dataUrl}" alt=""><div class="layer-main"><b>${esc(l.name)}</b><span>${l.scope==="bubble"?"모든 말풍선에 표시":"화면에 한 번만 표시"}</span></div><span class="modal-layer-badge">${(l.positionMode||"smart")==="smart"?`${dirKo(l.xSelf||"left")}→${dirKo(l.xTarget||"left")}`:(l.positionMode==="ratio"?"비율 배치":anchorKo(l.anchor))}</span>`;
  item.onclick=()=>selectLayer(l.id,0);
  wrap.appendChild(item);
 });
}
function renderLayerList(){
 const list=$("layerList");list.innerHTML="";
 decorations.slice().reverse().forEach(l=>{const item=document.createElement("div");item.className="layer-item"+(selected.type==="layer"&&selected.id===l.id?" selected":"");item.innerHTML=`<img class="thumb" src="${l.dataUrl}"><div><div class="layer-name">${esc(l.name)}</div><div class="layer-scope">${l.scope==="bubble"?"모든 말풍선에 표시":"화면에 한 번만 표시"}</div></div><span class="pill">${(l.positionMode||"smart")==="smart"?`${dirKo(l.xSelf||"left")}→${dirKo(l.xTarget||"left")} · ${dirKo(l.ySelf||"center")}→${dirKo(l.yTarget||"center")}`:(l.positionMode==="ratio"?`${Math.round(l.xRatio??0)}%, ${Math.round(l.yRatio??50)}%`:anchorKo(l.anchor))}</span>`;item.onclick=()=>selectLayer(l.id,0);list.appendChild(item)});
 renderModalLayerList();
 syncLayerEditor()
}
function pinRead(target,self,ratio,offset,axis){
 const free=target==="free";
 if(free)return`${Math.round((ratio??50)*10)/10}% 자유`;
 const targetNames=axis==="x"?{left:"말풍선 왼쪽",center:"말풍선 가운데",right:"말풍선 오른쪽"}:{top:"말풍선 위",center:"말풍선 가운데",bottom:"말풍선 아래"};
 const selfNames=axis==="x"?{left:"이미지 왼쪽",center:"이미지 가운데",right:"이미지 오른쪽"}:{top:"이미지 위",center:"이미지 가운데",bottom:"이미지 아래"};
 return`${selfNames[self]} ↔ ${targetNames[target]}${offset?` ${offset>0?"+":""}${Math.round(offset)}px`:""}`
}
function syncLayerEditor(){
 const l=selectedLayer();renderModalLayerList();$("layerEditor").classList.toggle("hidden",!l);if(!l)return;
 l.positionMode=l.positionMode||"smart";
 l.xTarget=l.xTarget||"left";l.xSelf=l.xSelf||"left";l.yTarget=l.yTarget||"center";l.ySelf=l.ySelf||"center";
 $("layerScope").value=l.scope;$("layerPositionMode").value=l.positionMode;
 $("layerWidth").value=Math.round(l.width);
 $("layerXTarget").value=l.xTarget;$("layerXSelf").value=l.xSelf;$("layerYTarget").value=l.yTarget;$("layerYSelf").value=l.ySelf;
 $("layerAnchor").value=l.anchor||"center-left";$("layerOffsetX").value=Math.round(l.offsetX||0);$("layerOffsetY").value=Math.round(l.offsetY||0);
 $("layerRatioX").value=Math.round((l.xRatio??0)*10)/10;$("layerRatioY").value=Math.round((l.yRatio??50)*10)/10;
 $("ratioXRead").textContent=`가로: ${pinRead(l.xTarget,l.xSelf,l.xRatio,l.xOffset,"x")}`;$("ratioYRead").textContent=`세로: ${pinRead(l.yTarget,l.ySelf,l.yRatio,l.yOffset,"y")}`;
 $("smartControls").classList.toggle("hidden",l.positionMode!=="smart");$("ratioControls").classList.toggle("hidden",l.positionMode!=="ratio");$("anchorControls").classList.toggle("hidden",l.positionMode!=="anchor")
}
function clearSelection(){ $("overlayFrame").classList.remove("selected");document.querySelectorAll(".sample-bubble").forEach(x=>x.classList.remove("selected"))}
function selectText(el){selected={type:"text",id:null,instance:[...document.querySelectorAll(".sample-bubble")].indexOf(el)};clearSelection();el.classList.add("selected");afterSelect()}
function selectFrame(){selected={type:"frame",id:null};clearSelection();$("overlayFrame").classList.add("selected");afterSelect()}
function selectBubble(el){selected={type:"bubble",id:null,instance:[...document.querySelectorAll(".sample-bubble")].indexOf(el)};clearSelection();el.classList.add("selected");afterSelect()}
function selectLayer(id,instance=0){selected={type:"layer",id,instance};clearSelection();afterSelect()}
function selectTail(instance=0){selected={type:"tail",id:null,instance};clearSelection();afterSelect()}
function afterSelect(){updateSelection();renderLayerList();renderLayers();renderTailParts()}
function updateSelection(){
 let title="선택 없음",sub="미리보기에서 편집할 항목을 클릭하세요.",kind="선택 없음";
 if(selected.type==="frame"){title="채팅 영역";sub="위쪽 파란 막대를 끌어 위치를 옮기고, 오른쪽 아래 조절점으로 크기를 바꿀 수 있습니다.";kind="채팅 영역"}
 if(selected.type==="bubble"){title="말풍선";sub="위에서 줄바꿈 너비 또는 안쪽 여백을 선택한 뒤 조절하세요.";kind="말풍선"}
 if(selected.type==="text"){title="글자 위치";sub="글자를 끌거나 방향키로 옮기세요. 말풍선 안의 여백만큼 이동하며, 같은 위치가 모든 말풍선에 적용됩니다.";kind="글자"}
 if(selected.type==="layer"){const l=selectedLayer();title="장식 이미지 · "+(l?.name||"");sub="지금 클릭한 이미지 하나를 움직입니다. 놓으면 같은 장식이 들어간 다른 말풍선에도 위치가 함께 적용됩니다.";kind="이미지"}
 if(selected.type==="tail"){title="말풍선 꼬리";sub="꼬리를 직접 끌어 위치를 옮기고, 조절점으로 크기를 바꿀 수 있습니다.";kind="꼬리"}
 $("selectionTitle").textContent=title;$("selectionSub").textContent=sub;$("selectionKind").textContent=kind;syncInspectorContext();syncDragHelper();syncTextPosition();syncBubbleEditing()
}

function activeBubble(){return document.querySelector(".sample-bubble.selected")}
function bubbleWidthSetting(b){return b?.classList.contains("donation")?"donationWidth":"maxWidth"}
function syncBubbleEditing(){
 const b=activeBubble();
 $("previewStage").dataset.bubbleEdit=bubbleEditMode;
 document.querySelectorAll("[data-bubble-edit]").forEach(el=>el.setAttribute("aria-pressed",String(el.dataset.bubbleEdit===bubbleEditMode)));
 const padding=bubbleEditMode==="padding",donation=b?.classList.contains("donation");
 $("bubbleWidthField").classList.toggle("hidden",padding);$("bubblePaddingFields").classList.toggle("hidden",!padding);
 $("bubbleWidthLabel").textContent=donation?"후원 너비":"최대 너비";
 if(document.activeElement!==$("bubbleWidthInput"))$("bubbleWidthInput").value=val(bubbleWidthSetting(b));
 $("bubbleWidthInput").min=donation?160:40;
 document.querySelectorAll("[data-padding-input]").forEach(el=>{if(document.activeElement!==el)el.value=val(el.dataset.paddingInput)});
 $("bubbleEditHint").textContent=padding?"안쪽 조절점으로 글자와 테두리 사이 거리를 바꿉니다. 글자는 직접 끌어 위치를 옮길 수 있습니다.":donation?"기준선을 당겨 후원 카드의 너비를 바꿉니다. 일반 채팅의 너비는 바뀌지 않습니다.":"기준선을 안쪽으로 당기면 긴 채팅이 더 여러 줄로 나뉩니다. 짧은 채팅을 같은 폭으로 늘리지 않습니다.";
 document.querySelectorAll(".bubble-wrap-guide").forEach(guide=>{
  const row=guide.parentElement,bubble=row.querySelector(".sample-bubble"),on=bubble===b&&!padding;
  guide.classList.toggle("hidden",!on);if(!on)return;
  const right=$("align").value==="right",width=Math.min(val(bubbleWidthSetting(bubble)),row.clientWidth);
  guide.style.width=width+"px";guide.style.left=right?"auto":"0";guide.style.right=right?"0":"auto";
  guide.classList.toggle("from-left",right);
  const handle=guide.querySelector(".bubble-resize");
  handle.setAttribute("aria-label",donation?"후원 너비 조절":"줄바꿈 최대 너비 조절");
  handle.setAttribute("aria-valuenow",String(val(bubbleWidthSetting(bubble))));handle.setAttribute("aria-valuemin",donation?"160":"40");handle.setAttribute("aria-valuemax","900");
  handle.title=(right?"오른쪽으로 당기면 좁아집니다":"왼쪽으로 당기면 좁아집니다")+" · 방향키로도 조절할 수 있습니다";
 });
}

function axisBand(value,start,size,first,mid,last){
 const ratio=(value-start)/Math.max(size,1);
 return ratio<.33?first:ratio>.67?last:mid
}
function nearestAnchor(centerX,centerY,tr){
 const h=axisBand(centerX,tr.left,tr.width,"left","center","right");
 const v=axisBand(centerY,tr.top,tr.height,"top","center","bottom");
 return v==="center"&&h==="center"?"center":`${v}-${h}`
}
function offsetsForRect(anchor,left,top,w,h,tr){
 const p=anchorParts(anchor),right=left+w,bottom=top+h,cx=left+w/2,cy=top+h/2,tcx=tr.left+tr.width/2,tcy=tr.top+tr.height/2;
 let ox,oy;
 if(p.h==="left")ox=left-tr.left;
 else if(p.h==="right")ox=tr.right-right;
 else ox=cx-tcx;
 if(p.v==="top")oy=top-tr.top;
 else if(p.v==="bottom")oy=tr.bottom-bottom;
 else oy=cy-tcy;
 return{ox:snap(ox),oy:snap(oy)}
}
function nearestPinPair(imagePoints,targetPoints){
 let best=null;
 for(const ip of imagePoints)for(const tp of targetPoints){
  const d=Math.abs(ip.value-tp.value);
  const exactCenter=ip.name==="center"&&tp.name==="center";
  const threshold=exactCenter?MAGNET_PX+6:MAGNET_PX;
  const priority=exactCenter?0:1;
  if(d<=threshold&&(!best||d<best.distance-0.01||(Math.abs(d-best.distance)<0.01&&priority<best.priority))){
   best={self:ip.name,target:tp.name,targetValue:tp.value,distance:d,priority}
  }
 }
 return best
}
function smartAxisDraft(rect,tr,axis){
 const isX=axis==="x";
 const imagePoints=isX
   ?[{name:"left",value:rect.left},{name:"center",value:rect.left+rect.width/2},{name:"right",value:rect.left+rect.width}]
   :[{name:"top",value:rect.top},{name:"center",value:rect.top+rect.height/2},{name:"bottom",value:rect.top+rect.height}];
 const targetPoints=isX
   ?[{name:"left",value:tr.left},{name:"center",value:tr.left+tr.width/2},{name:"right",value:tr.right}]
   :[{name:"top",value:tr.top},{name:"center",value:tr.top+tr.height/2},{name:"bottom",value:tr.bottom}];
 const m=snapEnabled?nearestPinPair(imagePoints,targetPoints):null;
 const center=isX?rect.left+rect.width/2:rect.top+rect.height/2,start=isX?tr.left:tr.top,size=isX?tr.width:tr.height;
 if(m)return{target:m.target,self:m.self,offset:0,ratio:((center-start)/Math.max(size,1))*100,snapped:true,snapValue:m.targetValue};
 return{target:"free",self:"center",ratio:clamp(((center-start)/Math.max(size,1))*100,-100,200),offset:0,snapped:false,snapValue:null}
}
function showSmartGuides(target,xDraft,yDraft){
 const tr=target.getBoundingClientRect(),fr=$("overlayFrame").getBoundingClientRect(),gv=$("guideV"),gh=$("guideH"),chip=$("snapChip");
 gv.style.display=xDraft.snapped?"block":"none";gh.style.display=yDraft.snapped?"block":"none";
 if(xDraft.snapped)gv.style.left=(xDraft.snapValue-fr.left)+"px";
 if(yDraft.snapped)gh.style.top=(yDraft.snapValue-fr.top)+"px";
 if(xDraft.snapped||yDraft.snapped){
  const exactCenter=xDraft.snapped&&yDraft.snapped&&xDraft.self==="center"&&xDraft.target==="center"&&yDraft.self==="center"&&yDraft.target==="center";
  const xLabel=xDraft.snapped?`${dirKo(xDraft.self)}↔${dirKo(xDraft.target)}`:"자유";
  const yLabel=yDraft.snapped?`${dirKo(yDraft.self)}↔${dirKo(yDraft.target)}`:"자유";
  chip.textContent=exactCenter?"정가운데에 붙음":`${xLabel} · ${yLabel}`;chip.style.display="block";
  chip.style.left=(Math.min(fr.width-130,Math.max(6,(xDraft.snapValue??tr.left)-fr.left+8)))+"px";
  chip.style.top=(Math.min(fr.height-24,Math.max(6,(yDraft.snapValue??tr.top)-fr.top+8)))+"px"
 }else chip.style.display="none"
}
function hideGuides(){$("guideV").style.display="none";$("guideH").style.display="none";$("snapChip").style.display="none"}

function startLayerDrag(e){
 e.preventDefault();e.stopPropagation();
 const el=e.currentTarget,l=decorations.find(x=>x.id===el.dataset.layerId);if(!l)return;
 const instance=+el.dataset.instance||0,target=el.parentElement,ir=el.getBoundingClientRect();
 dragState={
  kind:"layer-move",layerId:l.id,instance,target,
  grabDx:e.clientX-ir.left,grabDy:e.clientY-ir.top,width:ir.width,height:ir.height,
  positionMode:l.positionMode||"smart",
  draft:(l.positionMode||"smart")==="smart"
    ?{positionMode:"smart",xTarget:l.xTarget||"left",xSelf:l.xSelf||"left",yTarget:l.yTarget||"center",ySelf:l.ySelf||"center",xRatio:l.xRatio??0,yRatio:l.yRatio??50,xOffset:l.xOffset||0,yOffset:l.yOffset||0}
    :(l.positionMode==="ratio"?{positionMode:"ratio",xRatio:l.xRatio??0,yRatio:l.yRatio??50}:{positionMode:"anchor",anchor:l.anchor,offsetX:l.offsetX,offsetY:l.offsetY})
 };
 selectLayer(l.id,instance)
}
function startLayerResize(e){
 e.preventDefault();e.stopPropagation();
 const l=decorations.find(x=>x.id===e.currentTarget.dataset.layerId);if(!l)return;
 const instance=+e.currentTarget.dataset.instance||selected.instance||0;
 dragState={kind:"layer-resize",layerId:l.id,instance,startX:e.clientX,startWidth:l.width,draftWidth:l.width};
 selectLayer(l.id,instance)
}
function startFrameMove(e){e.preventDefault();e.stopPropagation();keepDirectGuideVisible();selectFrame();const t=theme();dragState={kind:"frame-move",startX:e.clientX,startY:e.clientY,x:t.canvas.x,y:t.canvas.y}}
function startFrameResize(e){e.preventDefault();e.stopPropagation();selectFrame();const t=theme();dragState={kind:"frame-resize",startX:e.clientX,startY:e.clientY,w:t.canvas.width,h:t.canvas.height}}
function startBubbleWidthDrag(e){
 if(e.button!==0||dragState)return;e.preventDefault();e.stopPropagation();
 const row=e.currentTarget.closest(".sample-row"),b=row.querySelector(".sample-bubble"),r=row.getBoundingClientRect(),handle=e.currentTarget;
 selectBubble(b);handle.setPointerCapture(e.pointerId);
 const id=bubbleWidthSetting(b),limit=Math.min(900,row.clientWidth);
 dragState={kind:"bubble-width",pointerId:e.pointerId,startX:e.clientX,scale:r.width/row.offsetWidth||1,fromLeft:$("align").value==="right",id,original:val(id),width:Math.min(val(id),limit),limit,minimum:Math.min(limit,id==="donationWidth"?160:Math.max(40,val("padLeft")+val("padRight")+2*val("borderWidth")+val("fontSize"))),moved:false};
}
function startTailDrag(e){
 e.preventDefault();e.stopPropagation();
 const tail=e.currentTarget,bubble=tail.parentElement,instance=+tail.dataset.instance||0,tr=tail.getBoundingClientRect(),t=theme(),side=effectiveTailSide(t);
 dragState={
  kind:"tail-move",instance,bubble,side,
  grabDx:e.clientX-(tr.left+tr.width/2),
  grabDy:e.clientY-tr.top,
  draftEdge:t.tail.edgeOffset,
  draftX:t.tail.xRatio,
  draftY:t.tail.yOffset
 };
 selectTail(instance)
}
function startTailResize(e){
 e.preventDefault();e.stopPropagation();
 const instance=+e.currentTarget.dataset.instance||0;
 dragState={
  kind:"tail-resize",instance,
  startX:e.clientX,startY:e.clientY,
  startW:val("tailWidth",18),startH:val("tailHeight",12),
  draftW:val("tailWidth",18),draftH:val("tailHeight",12)
 };
 selectTail(instance)
}
function startPaddingDrag(e){
 if(e.button!==0||dragState)return;e.preventDefault();e.stopPropagation();const b=e.currentTarget.closest(".sample-bubble"),side=e.currentTarget.dataset.side;selectBubble(b);e.currentTarget.setPointerCapture(e.pointerId);
 dragState={kind:"padding",pointerId:e.pointerId,side,startX:e.clientX,startY:e.clientY,scale:b.getBoundingClientRect().width/b.offsetWidth||1,padding:{...theme().bubble.padding},start:val(side==="left"?"padLeft":side==="right"?"padRight":side==="top"?"padTop":"padBottom")}
}

// Move the text by redistributing existing padding. Total padding and wrapping
// width stay unchanged, so short/long messages and provider emotes stay in flow.
function textAlignment(t){return ["left","center","right"].includes(t.typography?.textAlign)?t.typography.textAlign:"left"}
function moveTextPadding(p,dx,dy){
 dx=clamp(dx,Math.max(-p.left,p.right-120),Math.min(p.right,120-p.left));
 dy=clamp(dy,Math.max(-p.top,p.bottom-120),Math.min(p.bottom,120-p.top));
 $("padLeft").value=p.left+dx;$("padRight").value=p.right-dx;
 $("padTop").value=p.top+dy;$("padBottom").value=p.bottom-dy;
}
function alignTextPadding(axis,alignment){
 const first=axis==="x"?"padLeft":"padTop",last=axis==="x"?"padRight":"padBottom";
 const total=val(first)+val(last),inset=Math.min(8,total/2);
 const start=clamp(alignment==="center"?total/2:alignment==="left"||alignment==="top"?inset:total-inset,Math.max(0,total-120),Math.min(120,total));
 $(first).value=start;$(last).value=total-start;
}
function syncTextPosition(){
 document.querySelectorAll("[data-text-align]").forEach(b=>{const on=b.dataset.textAlign===$("textAlign").value;b.classList.toggle("active",on);b.setAttribute("aria-pressed",String(on))});
 const top=val("padTop"),bottom=val("padBottom"),inset=Math.min(8,(top+bottom)/2);
 const vertical=Math.abs(top-bottom)<1?"center":Math.abs(top-inset)<1?"top":Math.abs(bottom-inset)<1?"bottom":null;
 document.querySelectorAll("[data-text-valign]").forEach(b=>{const on=b.dataset.textValign===vertical;b.classList.toggle("active",on);b.setAttribute("aria-pressed",String(on))});
 document.querySelectorAll(".chat-text-content").forEach((el,i)=>el.classList.toggle("text-selected",selected.type==="text"&&selected.instance===i));
}
function startTextDrag(e){
 if(e.button!==0||dragState)return;
 e.preventDefault();e.stopPropagation();const el=e.currentTarget,b=el.closest(".sample-bubble");
 selectText(b);el.focus({preventScroll:true});el.setPointerCapture(e.pointerId);
 dragState={kind:"text-move",pointerId:e.pointerId,target:el,startX:e.clientX,startY:e.clientY,padding:{...theme().bubble.padding},scale:b.getBoundingClientRect().width/b.offsetWidth||1,moved:false};
}
function cancelTextDrag(){
 if(dragState?.kind==="bubble-width"){
  $(dragState.id).value=dragState.original;dragState=null;refresh(false);return;
 }
 if(!["text-move","padding"].includes(dragState?.kind))return;
 moveTextPadding(dragState.padding,0,0);dragState=null;refresh(false);
}
window.addEventListener("pointercancel",cancelTextDrag);
window.addEventListener("blur",cancelTextDrag);

window.addEventListener("pointermove",e=>{
 if(!dragState)return;
 if(dragState.kind==="text-move"){
  if(e.pointerId!==dragState.pointerId)return;
  if(!dragState.moved&&Math.hypot(e.clientX-dragState.startX,e.clientY-dragState.startY)<4)return;
  dragState.moved=true;
  moveTextPadding(dragState.padding,Math.round((e.clientX-dragState.startX)/dragState.scale),Math.round((e.clientY-dragState.startY)/dragState.scale));
  applyVars();setPreview();syncTextPosition();return;
 }
 if(dragState.kind==="layer-move"){
  const l=decorations.find(x=>x.id===dragState.layerId);if(!l||!dragState.target?.isConnected)return;
  const tr=dragState.target.getBoundingClientRect(),left=e.clientX-dragState.grabDx,top=e.clientY-dragState.grabDy,cx=left+dragState.width/2,cy=top+dragState.height/2;
  let xDraft,yDraft;
  if(dragState.positionMode==="smart"){
   const rect={left,top,width:dragState.width,height:dragState.height};
   xDraft=smartAxisDraft(rect,tr,"x");yDraft=smartAxisDraft(rect,tr,"y");
   dragState.draft={
    positionMode:"smart",
    xTarget:xDraft.target,xSelf:xDraft.self,yTarget:yDraft.target,ySelf:yDraft.self,
    xRatio:xDraft.ratio,yRatio:yDraft.ratio,xOffset:xDraft.offset,yOffset:yDraft.offset
   };
   $("layerXTarget").value=xDraft.target;$("layerXSelf").value=xDraft.self;$("layerYTarget").value=yDraft.target;$("layerYSelf").value=yDraft.self;
   $("ratioXRead").textContent=`가로: ${pinRead(xDraft.target,xDraft.self,xDraft.ratio,xDraft.offset,"x")}`;
   $("ratioYRead").textContent=`세로: ${pinRead(yDraft.target,yDraft.self,yDraft.ratio,yDraft.offset,"y")}`
  }else if(dragState.positionMode==="ratio"){
   let rx=((cx-tr.left)/Math.max(tr.width,1))*100,ry=((cy-tr.top)/Math.max(tr.height,1))*100;
   rx=clamp(rx,-100,200);ry=clamp(ry,-100,200);
   dragState.draft={positionMode:"ratio",xRatio:rx,yRatio:ry};
   $("layerRatioX").value=Math.round(rx*10)/10;$("layerRatioY").value=Math.round(ry*10)/10
  }else{
   const a=nearestAnchor(cx,cy,tr),o=offsetsForRect(a,left,top,dragState.width,dragState.height,tr);
   dragState.draft={positionMode:"anchor",anchor:a,offsetX:o.ox,offsetY:o.oy};
   $("layerAnchor").value=a;$("layerOffsetX").value=o.ox;$("layerOffsetY").value=o.oy
  }
  const img=document.querySelector(`.deco-layer[data-layer-id="${l.id}"][data-instance="${dragState.instance}"]`);
  if(img){
   const draft={...l,...dragState.draft};["left","right","top","bottom","transform"].forEach(k=>img.style[k]="");styleObj(img,anchorStyle(draft));
   const h=img.parentElement.querySelector(".deco-resize");if(h)positionResizeHandle(h,img,img.parentElement);
   if(dragState.positionMode==="smart")showSmartGuides(img.parentElement,xDraft,yDraft);else hideGuides()
  }
 }
 if(dragState.kind==="layer-resize"){
  const l=decorations.find(x=>x.id===dragState.layerId);if(l){
   const w=clamp(snap(dragState.startWidth+(e.clientX-dragState.startX)),8,500);dragState.draftWidth=w;
   const img=document.querySelector(`.deco-layer[data-layer-id="${l.id}"][data-instance="${dragState.instance}"]`);
   if(img){img.style.width=w+"px";const h=img.parentElement.querySelector(".deco-resize");if(h)positionResizeHandle(h,img,img.parentElement)}
   $("layerWidth").value=w
  }
 }
 if(dragState.kind==="frame-move"){keepDirectGuideVisible();const st=$("previewStage").getBoundingClientRect();$("frameX").value=clamp(snap(dragState.x+(e.clientX-dragState.startX)),0,Math.max(0,st.width-80));$("frameY").value=clamp(snap(dragState.y+(e.clientY-dragState.startY)),0,Math.max(0,st.height-80));refresh(false)}
 if(dragState.kind==="frame-resize"){
  $("frameWidth").value=clamp(snap(dragState.w+(e.clientX-dragState.startX)),240,1400);
  $("frameHeight").value=clamp(snap(dragState.h+(e.clientY-dragState.startY)),420,1000);
  refresh(false)
 }
 if(dragState.kind==="bubble-width"){
  if(e.pointerId!==dragState.pointerId)return;
  if(!dragState.moved&&Math.abs(e.clientX-dragState.startX)<4)return;
  dragState.moved=true;
  $(dragState.id).value=clamp(Math.round(dragState.width+(e.clientX-dragState.startX)/dragState.scale*(dragState.fromLeft?-1:1)),dragState.minimum,dragState.limit);
  refresh(false);
 }
 if(dragState.kind==="tail-move"){
  const bubble=dragState.bubble?.isConnected?dragState.bubble:document.querySelectorAll(".sample-bubble")[dragState.instance];
  const tail=bubble?.querySelector(".tail-part");
  if(bubble&&tail){
   const br=bubble.getBoundingClientRect(),cx=e.clientX-dragState.grabDx,cy=e.clientY-dragState.grabDy;
   let side=dragState.side,edge=dragState.draftEdge,xr=dragState.draftX,yo=cy-br.bottom;

   if(side==="left")edge=cx-br.left;
   else if(side==="right")edge=br.right-cx;
   else xr=((cx-br.left)/Math.max(br.width,1))*100;

   if(snapEnabled){
    if(side==="free")for(const p of [18,50,82])if(Math.abs(xr-p)<3)xr=p;
    if(Math.abs(yo)<MAGNET_PX)yo=0
   }

   edge=clamp(snap(edge),-40,120);
   xr=clamp(xr,-30,130);
   yo=clamp(snap(yo),-40,80);

   dragState.draftEdge=edge;dragState.draftX=xr;dragState.draftY=yo;
   const tt=theme();tt.tail.edgeOffset=edge;tt.tail.xRatio=xr;tt.tail.yOffset=yo;
   applyTailPositionStyle(tail,tt);
   const h=bubble.querySelector(".tail-resize");if(h)positionTailResizeHandle(h,tail,bubble)
  }
 }
 if(dragState.kind==="tail-resize"){
  const bubble=document.querySelectorAll(".sample-bubble")[dragState.instance],tail=bubble?.querySelector(".tail-part");
  const w=clamp(snap(dragState.startW+(e.clientX-dragState.startX)),6,80);
  const hgt=clamp(snap(dragState.startH+(e.clientY-dragState.startY)),4,60);
  dragState.draftW=w;dragState.draftH=hgt;
  if(tail){
   tail.style.width=w+"px";tail.style.height=hgt+"px";
   const h=bubble.querySelector(".tail-resize");if(h)positionTailResizeHandle(h,tail,bubble)
  }
 }
 if(dragState.kind==="padding"){
  if(e.pointerId!==dragState.pointerId)return;
  let next=dragState.start;
  if(dragState.side==="left")next+=(e.clientX-dragState.startX)/dragState.scale;
  if(dragState.side==="right")next-=(e.clientX-dragState.startX)/dragState.scale;
  if(dragState.side==="top")next+=(e.clientY-dragState.startY)/dragState.scale;
  if(dragState.side==="bottom")next-=(e.clientY-dragState.startY)/dragState.scale;
  next=clamp(snap(next),0,120);
  const id=dragState.side==="left"?"padLeft":dragState.side==="right"?"padRight":dragState.side==="top"?"padTop":"padBottom";
  $(id).value=next;
  if($("linkPadding").checked){["padTop","padRight","padBottom","padLeft"].forEach(x=>$(x).value=next)}
  refresh(false)
 }
});
window.addEventListener("pointerup",e=>{
 if(["text-move","bubble-width","padding"].includes(dragState?.kind)&&e.pointerId!==dragState.pointerId)return;
 if(dragState?.kind==="layer-move"){
  const l=decorations.find(x=>x.id===dragState.layerId);
  if(l&&dragState.draft){
   l.positionMode=dragState.draft.positionMode;
   if(l.positionMode==="smart"){
    l.xTarget=dragState.draft.xTarget;l.xSelf=dragState.draft.xSelf;l.yTarget=dragState.draft.yTarget;l.ySelf=dragState.draft.ySelf;
    l.xRatio=dragState.draft.xRatio;l.yRatio=dragState.draft.yRatio;l.xOffset=dragState.draft.xOffset;l.yOffset=dragState.draft.yOffset
   }else if(l.positionMode==="ratio"){l.xRatio=dragState.draft.xRatio;l.yRatio=dragState.draft.yRatio}
   else{l.anchor=dragState.draft.anchor;l.offsetX=dragState.draft.offsetX;l.offsetY=dragState.draft.offsetY}
  }
 }
 if(dragState?.kind==="layer-resize"){
  const l=decorations.find(x=>x.id===dragState.layerId);if(l&&dragState.draftWidth!=null)l.width=dragState.draftWidth
 }
 if(dragState?.kind==="tail-move"){
  $("tailEdgeOffset").value=Math.round(dragState.draftEdge??val("tailEdgeOffset",18));
  $("tailEdgeOffsetEasy").value=$("tailEdgeOffset").value;
  $("tailX").value=Math.round((dragState.draftX??val("tailX",82))*10)/10;
  $("tailY").value=Math.round(dragState.draftY??val("tailY",0))
 }
 if(dragState?.kind==="tail-resize"){
  $("tailWidth").value=Math.round(dragState.draftW??val("tailWidth",18));
  $("tailHeight").value=Math.round(dragState.draftH??val("tailHeight",12))
 }
 const needsRefresh=["text-move","bubble-width","padding","layer-move","layer-resize","tail-move","tail-resize"].includes(dragState?.kind);
 dragState=null;hideGuides();if(needsRefresh)refresh()
});

window.addEventListener("keydown",e=>{
 if(e.key==="Escape"&&["text-move","bubble-width","padding"].includes(dragState?.kind)){e.preventDefault();cancelTextDrag();return}
 if(selected.type!=="layer"||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;
 const l=selectedLayer();if(!l)return;e.preventDefault();const d=e.shiftKey?10:1;
 const horizontal=e.key==="ArrowLeft"||e.key==="ArrowRight",positive=e.key==="ArrowRight"||e.key==="ArrowDown";
 if((l.positionMode||"smart")==="smart"){
  const img=document.querySelector(`.deco-layer[data-layer-id="${l.id}"][data-instance="${selected.instance||0}"]`),tr=img?.parentElement?.getBoundingClientRect();
  if(tr){
   if(horizontal){
    if((l.xTarget||"left")==="free")l.xRatio=clamp((l.xRatio??0)+(positive?d:-d)/Math.max(tr.width,1)*100,-100,200);
    else l.xOffset=(l.xOffset||0)+(positive?d:-d)
   }else{
    if((l.yTarget||"center")==="free")l.yRatio=clamp((l.yRatio??50)+(positive?d:-d)/Math.max(tr.height,1)*100,-100,200);
    else l.yOffset=(l.yOffset||0)+(positive?d:-d)
   }
  }
 }else if(l.positionMode==="ratio"){
  const img=document.querySelector(`.deco-layer[data-layer-id="${l.id}"][data-instance="${selected.instance||0}"]`),tr=img?.parentElement?.getBoundingClientRect();
  if(tr){if(horizontal)l.xRatio=clamp((l.xRatio??0)+(positive?d:-d)/Math.max(tr.width,1)*100,-100,200);else l.yRatio=clamp((l.yRatio??50)+(positive?d:-d)/Math.max(tr.height,1)*100,-100,200)}
 }else{
  const p=anchorParts(l.anchor);
  if(horizontal){if(p.h==="right")l.offsetX+=positive?-d:d;else l.offsetX+=positive?d:-d}
  else{if(p.v==="bottom")l.offsetY+=positive?-d:d;else l.offsetY+=positive?d:-d}
 }
 refresh(false)
});

function refresh(full=true){
 applyVars();setFrame();setPreview();syncQuickAndAdvanced();syncPatternUi();
 syncTextPosition();
 if(full)renderLayerList();renderLayers();renderTailParts();
 const exportTheme=theme(),exportAdapter=$("adapter").value,css=generateCss(exportTheme,exportAdapter);$("output").value=css;validateCss(css,exportTheme,exportAdapter);if($("adapterBadge"))$("adapterBadge").textContent=$("adapter").value==="weflab"?"위플랩용":"직접 제작 HTML용";updateSelection()
}


function hexToRgba(hex,a){
 const h=(hex||"#000000").replace("#","");
 const x=h.length===3?h.split("").map(c=>c+c).join(""):h;
 const v=parseInt(x||"000000",16);
 return `rgba(${(v>>16)&255},${(v>>8)&255},${v&255},${Math.max(0,Math.min(1,a))})`
}
function patternLayer(t){
 const p=t.pattern||{preset:"none",color:"#000000",opacity:0,size:18};
 if(!p.preset||p.preset==="none"||p.opacity<=0)return{image:"none",size:"auto"};
 const c=hexToRgba(p.color,p.opacity),s=Math.max(6,p.size||18),half=Math.max(3,Math.round(s/2));
 if(p.preset==="dots")return{image:`radial-gradient(circle, ${c} 1.6px, transparent 1.8px)`,size:`${s}px ${s}px`};
 if(p.preset==="grid")return{image:`linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`,size:`${s}px ${s}px`};
 if(p.preset==="diagonal")return{image:`repeating-linear-gradient(135deg, ${c} 0 2px, transparent 2px ${half}px)`,size:`${s}px ${s}px`};
 if(p.preset==="cross")return{image:`linear-gradient(90deg, transparent 46%, ${c} 46% 54%, transparent 54%), linear-gradient(transparent 46%, ${c} 46% 54%, transparent 54%)`,size:`${s}px ${s}px`};
 if(p.preset==="checker")return{image:`linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%), linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%)`,size:`${s}px ${s}px`};
 if(p.preset==="waves")return{image:`radial-gradient(ellipse at 50% 100%, transparent 55%, ${c} 57% 62%, transparent 64%)`,size:`${s}px ${half}px`};
 if(p.preset==="sparkle")return{image:`radial-gradient(circle, ${c} 0 1px, transparent 1.5px), linear-gradient(45deg, transparent 46%, ${c} 47% 53%, transparent 54%), linear-gradient(-45deg, transparent 46%, ${c} 47% 53%, transparent 54%)`,size:`${s}px ${s}px`};
 return{image:"none",size:"auto"}
}
function bubbleBackgroundCss(t,important=false){
 const p=patternLayer(t),imp=important?"!important":"";
 if(p.image==="none")return`background:${t.bubble.background}${imp};`;
 return`background-color:${t.bubble.background}${imp};\n  background-image:${p.image}${imp};\n  background-size:${p.size}${imp};\n  background-position:0 0${imp};`
}
function bubbleDecl(t){return`
  ${bubbleBackgroundCss(t)}
  color:${t.bubble.textColor};
  border:${t.bubble.borderWidth}px solid ${t.bubble.borderColor};
  border-radius:${t.bubble.radius.tl}px ${t.bubble.radius.tr}px ${t.bubble.radius.br}px ${t.bubble.radius.bl}px;
  padding:${t.bubble.padding.top}px ${t.bubble.padding.right}px ${t.bubble.padding.bottom}px ${t.bubble.padding.left}px;
  max-width:min(${t.layout.maxWidth}px,100%);
  box-shadow:0 4px 0 rgba(0,0,0,.12),0 8px 18px rgba(0,0,0,.10);
  width:fit-content;
  box-sizing:border-box;
  word-break:break-word;
  font-size:${t.typography.fontSize}px;
  line-height:${t.typography.lineHeight};
  font-weight:${t.typography.fontWeight};
  letter-spacing:${t.typography.letterSpacing}px;`.trim()}

/*
  Preview renderer / Generic adapter와 Weflab adapter는 의도적으로 분리한다.
  Weflab에서는 서비스 부모 레이아웃을 바꾸지 않고 chat_box 외곽만 최소 개입한다.
*/
function weflabBubbleDecl(t){return`
  position:relative!important;
  box-sizing:border-box!important;
  width:fit-content!important;
  box-shadow:0 4px 0 rgba(0,0,0,.12),0 8px 18px rgba(0,0,0,.10)!important;
  min-width:0!important;
  max-width:min(${t.layout.maxWidth}px,94%)!important;
  padding:0!important;
  color:${t.bubble.textColor}!important;
  ${bubbleBackgroundCss(t,true)}
  border:${t.bubble.borderWidth}px solid ${t.bubble.borderColor}!important;
  border-radius:${t.bubble.radius.tl}px ${t.bubble.radius.tr}px ${t.bubble.radius.br}px ${t.bubble.radius.bl}px!important;
  overflow:visible!important;
  font-size:${t.typography.fontSize}px!important;
  line-height:${t.typography.lineHeight}!important;
  font-weight:${t.typography.fontWeight}!important;
  letter-spacing:${t.typography.letterSpacing}px!important;`.trim()}

function cssTransformFromAnchorStyle(l){
 const st=anchorStyle(l),parts=[];
 for(const key of ["left","right","top","bottom"])if(st[key]!=null)parts.push(`${key}:${st[key]}!important;`);
 if(st.transform)parts.push(`transform:${st.transform}!important;`);
 return parts.join("")
}
function exactDecorationPseudo(selector,l,z=2){
 const w=Math.round(l.width),h=Math.max(1,Math.round(l.width/(l.aspectRatio||1)));
 return`${selector}::before{
  content:""!important;
  position:absolute!important;
  width:${w}px!important;
  height:${h}px!important;
  inset:auto!important;
  transform:none!important;
  ${cssTransformFromAnchorStyle(l)}
  background-image:url("${l.dataUrl}")!important;
  background-repeat:no-repeat!important;
  background-position:center!important;
  background-size:contain!important;
  pointer-events:none!important;
  z-index:${z}!important;
}`
}
function layerOutset(l){
 const w=Math.round(l.width),h=Math.max(1,Math.round(l.width/(l.aspectRatio||1)));
 const ox=Math.abs(l.xOffset??l.offsetX??0),oy=Math.abs(l.yOffset??l.offsetY??0);
 return Math.ceil(Math.max(w,h)+ox+oy+16)
}
function boundedMultiBg(selector,layers,z=2){
 if(!layers.length)return"";
 if(layers.length===1)return exactDecorationPseudo(selector,layers[0],z);

 // CSS-only Weflab cannot create arbitrary extra DOM nodes.
 // For 2+ images use one tightly-bounded pseudo canvas instead of the old fixed inset:-240px canvas.
 const ordered=[...layers].reverse();
 const margin=Math.max(32,...ordered.map(layerOutset));
 const imgs=ordered.map(l=>`url("${l.dataUrl}")`).join(",\n    ");
 const sizes=ordered.map(l=>`${Math.round(l.width)}px auto`).join(", ");
 const repeats=ordered.map(()=>"no-repeat").join(", ");
 const pos=ordered.map(l=>{
  const w=Math.round(l.width),h=Math.max(1,Math.round(l.width/(l.aspectRatio||1)));
  const mode=l.positionMode||"smart";
  let tx=.5,ty=.5,sx=.5,sy=.5,ox=0,oy=0;
  if(mode==="smart"){
   const tfx={left:0,center:.5,right:1,free:(l.xRatio??0)/100};
   const tfy={top:0,center:.5,bottom:1,free:(l.yRatio??50)/100};
   tx=tfx[l.xTarget||"left"]; ty=tfy[l.yTarget||"center"];
   sx=SELF_FACTOR_X[l.xSelf||"left"]??.5; sy=SELF_FACTOR_Y[l.ySelf||"center"]??.5;
   ox=l.xTarget==="free"?0:(l.xTarget==="right"?-1:1)*(l.xOffset||0);
   oy=l.yTarget==="free"?0:(l.yTarget==="bottom"?-1:1)*(l.yOffset||0);
  }else if(mode==="ratio"){
   tx=(l.xRatio??0)/100;ty=(l.yRatio??50)/100;sx=.5;sy=.5;
  }else{
   const p=anchorParts(l.anchor);
   tx=p.h==="left"?0:p.h==="right"?1:.5;
   ty=p.v==="top"?0:p.v==="bottom"?1:.5;
   sx=tx;sy=ty;
   ox=p.h==="right"?-(l.offsetX||0):(l.offsetX||0);
   oy=p.v==="bottom"?-(l.offsetY||0):(l.offsetY||0);
  }
  const cx=margin*(1-2*tx)+(tx-sx)*w+ox;
  const cy=margin*(1-2*ty)+(ty-sy)*h+oy;
  return`calc(${(tx*100).toFixed(2)}% + ${cx.toFixed(2)}px) calc(${(ty*100).toFixed(2)}% + ${cy.toFixed(2)}px)`
 }).join(",\n    ");
 return`/* Weflab CSS-only 다중 이미지 fallback: 필요한 범위만 확장한 pseudo canvas */
${selector}::before{
  content:""!important;
  position:absolute!important;
  inset:-${margin}px!important;
  width:auto!important;
  height:auto!important;
  transform:none!important;
  background-image:${imgs}!important;
  background-repeat:${repeats}!important;
  background-size:${sizes}!important;
  background-position:${pos}!important;
  pointer-events:none!important;
  z-index:${z}!important;
}`
}
function multiBg(selector,layers){return boundedMultiBg(selector,layers,2)}
function tailCss(selector,t,important=false){
 if(!t.tail.enabled||t.tail.shape==="none")return"";
 const imp=important?"!important":"";
 const side=t.tail.alignMode==="auto"?(t.layout.alignment==="right"?"right":"left"):t.tail.alignMode;
 const pos=side==="left"
  ?`left:${t.tail.edgeOffset}px${imp};`
  :side==="right"
    ?`right:${t.tail.edgeOffset}px${imp};`
    :`left:${t.tail.xRatio}%${imp};`;
 const translate=side==="left"
  ?"translate(-50%,-2px)"
  :side==="right"
    ?"translate(50%,-2px)"
    :"translate(-50%,-2px)";
 const poly=t.tail.shape==="soft"?"7% 0,93% 0,50% 100%":"0 0,100% 0,50% 100%";
 const shadow=t.tail.borderWidth>0
  ?`filter:drop-shadow(0 0 ${t.tail.borderWidth}px ${t.tail.borderColor})${imp};`
  :`filter:none${imp};`;
 return`${selector}::after{
  content:""${imp};
  position:absolute${imp};
  ${pos}
  top:calc(100% + ${t.tail.yOffset}px)${imp};
  width:${t.tail.width}px${imp};
  height:${t.tail.height}px${imp};
  background:${t.tail.background}${imp};
  clip-path:polygon(${poly})${imp};
  ${shadow}
  transform:${translate}${imp};
  pointer-events:none${imp};
  z-index:0${imp};
}`
}
function weflabCss(t){
 const bubbleLayers=t.decorations.filter(x=>x.visible!==false&&x.scope==="bubble");
 const overlayLayers=t.decorations.filter(x=>x.visible!==false&&x.scope==="overlay");
 const right=t.layout.alignment==="right";
 const alignMargin=right
  ?`margin-left:auto!important;margin-right:0!important;`
  :`margin-left:0!important;margin-right:auto!important;`;
 const eventTextAlign=t.donation.center?"center":textAlignment(t);
 // Weflab already positions #page_wrap absolutely; preserve its viewport sizing.
 const overlayAnchorCss="";
 return`/* 채팅창 꾸미기 v0.35 · Byeollog Weflab Adapter 1.1
   Preview 렌더러와 분리된 위플랩 전용 출력입니다.
   - chat_list position/display/flex/overflow/height 구조를 변경하지 않음
   - img/emote/emoji/sticker 내부 DOM 직접 선택 안 함
   - 부모 폭/후원 숫자 줄바꿈 안전장치 포함
*/
html,
body,
#page_wrap{
  background:transparent!important;
}
#page_wrap,
#page_wrap .chat_list{
  -webkit-mask-image:none!important;
  mask-image:none!important;
}
#page_wrap .chat_list{
  box-sizing:border-box!important;
  padding-left:0!important;
  padding-right:2px!important;
}
${overlayAnchorCss}
#page_wrap .chat_list .chat_box{
  ${weflabBubbleDecl(t)}
  ${alignMargin}
  margin-top:0!important;
  margin-bottom:${t.layout.gap}px!important;
}
#page_wrap .chat_list .chat_box .inner_box{
  position:relative!important;
  box-sizing:border-box!important;
  padding:${t.bubble.padding.top}px ${t.bubble.padding.right}px ${t.bubble.padding.bottom}px ${t.bubble.padding.left}px!important;
  background-color:transparent!important;
  text-align:${textAlignment(t)}!important;
}
#page_wrap .chat_list .chat_box.chat{
  overflow-wrap:anywhere;
  word-break:break-word;
}
/* Service text rules must not override the selected typography. */
#page_wrap .chat_list .chat_box .text,
#page_wrap .chat_list .chat_box .text_box .val{
  color:${t.bubble.textColor}!important;
  font-size:${t.typography.fontSize}px!important;
  line-height:${t.typography.lineHeight}!important;
  font-weight:${t.typography.fontWeight}!important;
  letter-spacing:${t.typography.letterSpacing}px!important;
  overflow-wrap:anywhere!important;
  word-break:break-word!important;
}
#page_wrap .chat_list .chat_box .name{
  float:none!important;
  display:${t.nickname.visible||t.visibility.platform||t.visibility.badge?(t.nickname.break?"block":"inline"):"none"}!important;
  margin:0 ${t.nickname.break?0:t.nickname.gap}px ${t.nickname.break?t.nickname.gap:0}px 0!important;
  padding:0!important;
  white-space:normal!important;
}
#page_wrap .chat_list .chat_box .text{float:none!important;display:${t.nickname.break?"block":"inline"}!important;margin:0!important;}
#page_wrap .chat_list .chat_box .nick{
  display:${t.nickname.visible?"inline":"none"}!important;
  color:${t.nickname.color}!important;
  font-size:${t.nickname.size}px!important;
  margin:0!important;
}
#page_wrap .chat_list .chat_box .name .icon_platform{display:${t.visibility.platform?"inline-block":"none"}!important;vertical-align:middle!important;}
#page_wrap .chat_list .chat_box .name .icon_badge{display:${t.visibility.badge?"inline-block":"none"}!important;vertical-align:middle!important;}

/* 후원 / 구독 / 시스템 카드 */
#page_wrap .chat_list .chat_box:not(.chat){
  width:min(${t.donation.width}px,calc(100% - 6px))!important;
  min-width:0!important;
  max-width:calc(100% - 6px)!important;
  text-align:${eventTextAlign}!important;
  ${alignMargin}
}
#page_wrap .chat_list .chat_box:not(.chat) .inner_box{
  text-align:${eventTextAlign}!important;
  border:0!important;
  outline:0!important;
  box-shadow:none!important;
}
${t.eventCards.useBubbleStyle?"":`#page_wrap .chat_list .chat_box:not(.chat){
  background:${t.eventCards.background}!important;
  color:${t.eventCards.textColor}!important;
  border:${t.eventCards.borderWidth}px solid ${t.eventCards.borderColor}!important;
  border-radius:${t.eventCards.radius}px!important;
}`}

/* Preserve provider artwork; style the event text without touching emotes. */
#page_wrap .chat_list .chat_box:not(.chat) .text,
#page_wrap .chat_list .chat_box:not(.chat) .text_box .val{
  color:${t.eventCards.useBubbleStyle?t.bubble.textColor:t.eventCards.textColor}!important;
  text-align:${eventTextAlign}!important;
}
#page_wrap .chat_list .chat_box:not(.chat) .text_box{min-width:0!important;max-width:100%!important;text-align:${eventTextAlign}!important;}
#page_wrap .chat_list .chat_box:not(.chat) .text_box .val b{white-space:nowrap!important;color:inherit!important;font-size:inherit!important;font-weight:inherit!important;}
#page_wrap .chat_list .chat_box:not(.chat) .donation_box .text_box{flex:1 1 0!important;width:auto!important;container-type:inline-size;}
@supports(font-size:1cqw){
  #page_wrap .chat_list .chat_box:not(.chat) .donation_box .text_box .val b{font-size:min(1em,10cqw)!important;}
}
/* 후원 닉네임 / 별풍선 수 */
#page_wrap .chat_list .chat_box:not(.chat) .name,
#page_wrap .chat_list .chat_box:not(.chat) .nick{
  max-width:100%!important;
  text-align:${eventTextAlign}!important;
  white-space:normal!important;
  overflow-wrap:anywhere!important;
}

${t.eventCards.stripServiceSurface?`/* Safe surface cleanup:
   직접 자식 div의 '색/테두리/그림자'만 정리하고 background-image는 보존합니다.
   이미지 유무 기반 판별은 사용하지 않습니다. */
#page_wrap .chat_list .chat_box:not(.chat) .inner_box > div{
  background-color:transparent!important;
  border-color:transparent!important;
  outline:0!important;
  box-shadow:none!important;
}`:""}

${boundedMultiBg("#page_wrap .chat_list .chat_box",bubbleLayers,2)}
${boundedMultiBg("#page_wrap",overlayLayers,1)}
${tailCss("#page_wrap .chat_list .chat_box",t,true)}
/* 실제 채팅 내부 img / emote / emoticon / emoji / sticker 크기·display·position은 재정의하지 않습니다. */`.trim()
}
function genericCss(t){
 const bubbleLayers=t.decorations.filter(x=>x.visible!==false&&x.scope==="bubble");
 const overlayLayers=t.decorations.filter(x=>x.visible!==false&&x.scope==="overlay");
 return`/* 채팅창 꾸미기 v0.35 · Byeollog HTML Adapter 1.1 */
.chat-stage{position:relative;width:${t.canvas.width}px;max-width:100%;height:${t.canvas.height}px;}
.chat-list{position:relative;display:flex;flex-direction:column;align-items:${t.layout.alignment==="right"?"flex-end":"flex-start"};gap:${t.layout.gap}px;width:100%;min-width:0;}
.chat-message{position:relative;text-align:${textAlignment(t)};${bubbleDecl(t)}}
${t.nickname.visible?`.chat-message .nickname{display:inline;color:${t.nickname.color};font-size:${t.nickname.size}px;}`:`.chat-message .nickname{display:none;}`}
.chat-message .text{display:${t.nickname.break?"block":"inline"};${t.nickname.break?`margin-top:${t.nickname.gap}px;`:`margin-left:${t.nickname.gap}px;`}}
${t.visibility.platform?"":`.chat-message .platform{display:none;}`}
${t.visibility.badge?"":`.chat-message .badge{display:none;}`}
.chat-message.donation{width:min(${t.donation.width}px,100%);min-width:min(${t.donation.width}px,100%);max-width:100%;text-align:${t.donation.center?"center":textAlignment(t)};}
${t.eventCards.useBubbleStyle?"":`.chat-message.event-card{
  background:${t.eventCards.background};
  color:${t.eventCards.textColor};
  border:${t.eventCards.borderWidth}px solid ${t.eventCards.borderColor};
  border-radius:${t.eventCards.radius}px;
}`}
${t.eventCards.stripServiceSurface?`.chat-message.event-card .event-service-surface{
  background:transparent!important;
  background-image:none!important;
  border:0!important;
  outline:0!important;
  box-shadow:none!important;
}`:""}
${multiBg(".chat-message",bubbleLayers)}
${multiBg(".chat-stage",overlayLayers)}
${tailCss(".chat-message",t)}`.trim()
}
function generateCss(t,adapter){
 return adapter==="weflab"?weflabCss(t):genericCss(t)
}
function validateCss(css,t=theme(),adapter=$("adapter").value){
 const clean=css.replace(/\/\*[\s\S]*?\*\//g,""),banned=[
  {re:/:has\s*\(/i,label:":has(...) 사용"},
  {re:/\.chat_box\.chat\s+img/i,label:".chat_box.chat img"},
  {re:/\.inner_box\s*>\s*\*/i,label:".inner_box > *"},
  {re:/\.(emote|emoticon|sticker|emoji)\b/i,label:"이모티콘 내부 직접 선택"},
  {re:/#page_wrap\s+\.chat_list\s*\{[^}]*(?:position|display|overflow|height)\s*:/is,label:"위플랩 chat_list 레이아웃 강제"},
  {re:/inset\s*:\s*-240px/i,label:"고정 -240px 장식 캔버스"}
 ];
 const hits=banned.filter(x=>x.re.test(clean)).map(x=>x.label);
 const warnings=[];
 if(adapter==="weflab"){
  const bubbleCount=t.decorations.filter(x=>x.visible!==false&&x.scope==="bubble").length;
  const overlayCount=t.decorations.filter(x=>x.visible!==false&&x.scope==="overlay").length;
  if(bubbleCount>1)warnings.push(`말풍선 장식 ${bubbleCount}개가 함께 표시됩니다.`);
  if(overlayCount>1)warnings.push(`화면 장식 ${overlayCount}개가 함께 표시됩니다.`);
 }
 const good=!hits.length;
 if($("safetyBadge"))$("safetyBadge").textContent=good?"CSS 생성 완료":"확인 필요";
 if($("safetyBadge"))$("safetyBadge").className="badge "+(good?"ok":"warn");
 if(!good){
  $("safetyText").innerHTML=`<span class="warn">⚠ ${hits.join(", ")}</span>`;
 }else if(warnings.length){
  $("safetyText").innerHTML=`<span class="ok">✓ CSS 생성 완료</span> · <span class="warn">${warnings.join(" · ")}</span>`;
 }else{
  $("safetyText").textContent="CSS를 만들었습니다. 적용 후 실제 채팅·이모티콘·후원 표시를 확인해 주세요.";
 }
}
function applyPreset(p){
 $("bgAdv").value=p.bg;$("textAdv").value=p.text;$("borderAdv").value=p.border;$("borderWidth").value=p.borderWidth;
 ["radTL","radTR","radBR","radBL"].forEach(id=>$(id).value=p.radius);$("align").value=p.align;
 $("tailEnabled").checked=p.tail!=="none";
 $("tailShape").value=p.tail==="none"?"none":"triangle";
 $("tailAlignMode").value=p.tail==="bottom-left"?"left":"auto";
 $("tailEdgeOffset").value=18;$("tailEdgeOffsetEasy").value=18;
 $("tailX").value=82;$("tailWidth").value=18;$("tailHeight").value=12;
 $("tailBorderWidth").value=2;$("tailY").value=0;$("tailLinkColors").checked=true;
 $("eventUseBubbleStyle").checked=true;$("eventStripServiceSurface").checked=true;refresh()
}
Object.entries(presets).forEach(([name,p])=>{
 const b=document.createElement("button");b.className="preset";
 b.innerHTML=`<span class="preset-swatch" style="--swatch-bg:${p.bg};--swatch-border:${p.border}"></span><span class="preset-name">${name}</span>`;
 b.onclick=()=>applyPreset(p);$("presetGrid").appendChild(b)
});

ids.forEach(id=>{
 const el=$(id);
 if(!el){
  console.warn(`[채팅창 꾸미기] 선택 항목을 찾지 못했습니다: #${id}`);
  return;
 }
 el.addEventListener("input",()=>{
  if(id.startsWith("pad")&&$("linkPadding").checked){const v=$(id).value;["padTop","padRight","padBottom","padLeft"].forEach(x=>$(x).value=v)}
  if(id.startsWith("rad")&&$("linkRadius").checked){const v=$(id).value;["radTL","radTR","radBL","radBR"].forEach(x=>$(x).value=v)}
  refresh()
 })
});
$("bg").addEventListener("input",()=>{$("bgAdv").value=$("bg").value;refresh()});$("text").addEventListener("input",()=>{$("textAdv").value=$("text").value;refresh()});$("border").addEventListener("input",()=>{$("borderAdv").value=$("border").value;refresh()});
$("radiusLinked").addEventListener("input",()=>{const v=$("radiusLinked").value;["radTL","radTR","radBR","radBL"].forEach(x=>$(x).value=v);refresh()});

document.querySelectorAll("[data-tail-align]").forEach(b=>b.addEventListener("click",()=>{
 $("tailEnabled").checked=true;
 if($("tailShape").value==="none")$("tailShape").value="triangle";
 $("tailAlignMode").value=b.dataset.tailAlign;
 document.querySelectorAll("[data-tail-align]").forEach(x=>x.classList.toggle("active",x===b));
 refresh()
}));
$("tailEdgeOffsetEasy").addEventListener("input",()=>{$("tailEdgeOffset").value=$("tailEdgeOffsetEasy").value;refresh()});
$("tailEdgeOffset").addEventListener("input",()=>{$("tailEdgeOffsetEasy").value=$("tailEdgeOffset").value;refresh()});
$("tailAlignMode").addEventListener("input",()=>{
 $("tailFixedControls").classList.toggle("hidden",$("tailAlignMode").value==="free");
 $("tailFreeControls").classList.toggle("hidden",$("tailAlignMode").value!=="free");
 refresh()
});
$("tailShape").addEventListener("input",()=>{$("tailEnabled").checked=$("tailShape").value!=="none";refresh()});
$("tailEnabled").addEventListener("input",()=>{
 if($("tailEnabled").checked&&$("tailShape").value==="none")$("tailShape").value="triangle";
 refresh()
});
$("tailLinkColors").addEventListener("input",()=>{syncQuickAndAdvanced();refresh()});

document.querySelectorAll("[data-align]").forEach(b=>b.onclick=()=>{$("align").value=b.dataset.align;refresh()});
document.querySelectorAll("[data-text-align]").forEach(b=>b.onclick=()=>{
 $("textAlign").value=b.dataset.textAlign;$("donationCenter").checked=b.dataset.textAlign==="center";
 alignTextPadding("x",b.dataset.textAlign);refresh();
});
document.querySelectorAll("[data-text-valign]").forEach(b=>b.onclick=()=>{alignTextPadding("y",b.dataset.textValign);refresh()});
document.querySelectorAll("[data-density]").forEach(b=>b.onclick=()=>{
 const d=b.dataset.density,vals=d==="tight"?{p:6,x:10,g:4}:d==="roomy"?{p:14,x:22,g:13}:{p:9,x:14,g:8};
 $("padTop").value=$("padBottom").value=vals.p;$("padLeft").value=$("padRight").value=vals.x;$("gap").value=vals.g;
 refresh()
});

$("easyMode").onclick=()=>{document.body.classList.remove("advanced");$("easyMode").classList.add("active");$("advancedMode").classList.remove("active");refresh()};
$("advancedMode").onclick=()=>{document.body.classList.add("advanced");$("advancedMode").classList.add("active");$("easyMode").classList.remove("active");refresh()};

$("snapToggle").onclick=()=>{snapEnabled=!snapEnabled;$("snapToggle").textContent="자석 정렬 "+(snapEnabled?"켜짐":"꺼짐");$("snapToggle").classList.toggle("active",snapEnabled)};
$("resetView").onclick=()=>{initialFramePosition();refresh();selectFrame()};

$("layerScope").addEventListener("input",()=>{const l=selectedLayer();if(l){
 l.scope=$("layerScope").value;l.positionMode="smart";
 l.xTarget="left";l.xSelf="left";l.yTarget=l.scope==="bubble"?"center":"top";l.ySelf=l.scope==="bubble"?"center":"top";
 l.xOffset=0;l.yOffset=0;l.xRatio=l.scope==="bubble"?0:10;l.yRatio=l.scope==="bubble"?50:10;
 refresh()
}});
$("layerPositionMode").addEventListener("input",()=>{const l=selectedLayer();if(!l)return;l.positionMode=$("layerPositionMode").value;if(l.positionMode==="smart"){l.xTarget=l.xTarget||"left";l.xSelf=l.xSelf||"left";l.yTarget=l.yTarget||"center";l.ySelf=l.ySelf||"center"}syncLayerEditor();refresh()});
$("layerXTarget").addEventListener("input",()=>{const l=selectedLayer();if(l){l.positionMode="smart";l.xTarget=$("layerXTarget").value;refresh()}});
$("layerXSelf").addEventListener("input",()=>{const l=selectedLayer();if(l){l.positionMode="smart";l.xSelf=$("layerXSelf").value;refresh()}});
$("layerYTarget").addEventListener("input",()=>{const l=selectedLayer();if(l){l.positionMode="smart";l.yTarget=$("layerYTarget").value;refresh()}});
$("layerYSelf").addEventListener("input",()=>{const l=selectedLayer();if(l){l.positionMode="smart";l.ySelf=$("layerYSelf").value;refresh()}});
$("layerAnchor").addEventListener("input",()=>{const l=selectedLayer();if(l){l.positionMode="anchor";l.anchor=$("layerAnchor").value;refresh()}});
["layerWidth","layerOffsetX","layerOffsetY","layerRatioX","layerRatioY"].forEach(id=>$(id).addEventListener("input",()=>{
 const l=selectedLayer();if(!l)return;
 if(id==="layerWidth")l.width=clamp(val(id),8,500);
 if(id==="layerOffsetX"){l.positionMode="anchor";l.offsetX=val(id)}
 if(id==="layerOffsetY"){l.positionMode="anchor";l.offsetY=val(id)}
 if(id==="layerRatioX"){l.positionMode="ratio";l.xRatio=clamp(val(id),-100,200)}
 if(id==="layerRatioY"){l.positionMode="ratio";l.yRatio=clamp(val(id),-100,200)}
 refresh(false)
}));
document.querySelectorAll("#positionGrid button").forEach(b=>b.addEventListener("click",()=>{
 const l=selectedLayer();if(!l)return;
 const rx=+b.dataset.rx,ry=+b.dataset.ry;l.positionMode="smart";
 l.xTarget=rx===0?"left":rx===50?"center":"right";l.xSelf=l.xTarget;
 l.yTarget=ry===0?"top":ry===50?"center":"bottom";l.ySelf=l.yTarget;
 l.xOffset=0;l.yOffset=0;l.xRatio=rx;l.yRatio=ry;refresh()
}));

const readImageFile=file=>new Promise((resolve,reject)=>{
 const r=new FileReader();
 r.onerror=reject;
 r.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>resolve({dataUrl:r.result,aspectRatio:(img.naturalWidth||1)/(img.naturalHeight||1)});img.src=r.result};
 r.readAsDataURL(file)
});
$("duplicateLayer").onclick=()=>{const l=selectedLayer();if(!l)return;const n={...l,id:uid(),name:l.name+" copy",offsetX:l.offsetX+12,offsetY:l.offsetY+12};decorations.push(n);selectLayer(n.id,0);refresh()};
$("deleteLayer").onclick=()=>{const l=selectedLayer();if(!l)return;decorations=decorations.filter(x=>x.id!==l.id);selected={type:null,id:null};refresh()};
$("layerFront").onclick=()=>{const l=selectedLayer();if(!l)return;decorations=decorations.filter(x=>x.id!==l.id);decorations.push(l);refresh()};
$("layerBack").onclick=()=>{const l=selectedLayer();if(!l)return;decorations=decorations.filter(x=>x.id!==l.id);decorations.unshift(l);refresh()};

$("overlayFrame").addEventListener("click",e=>{if(e.target.closest(".sample-bubble,.deco-layer,.deco-resize,.tail-part,.tail-resize,.frame-resize,.frame-editbar"))return;selectFrame()});
document.querySelectorAll(".sample-bubble").forEach(b=>{
 b.addEventListener("click",e=>{if(e.target.closest(".chat-text-content,.deco-layer,.deco-resize,.tail-part,.tail-resize,.bubble-resize,.pad-handle"))return;e.stopPropagation();selectBubble(b)});
 const text=b.querySelector(".chat-text-content");
 text.addEventListener("pointerdown",startTextDrag);
 text.addEventListener("click",e=>{e.stopPropagation();selectText(b);syncTextPosition()});
 text.addEventListener("keydown",e=>{
  if(e.key==="Escape"){e.preventDefault();cancelTextDrag();return}
  if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;
  e.preventDefault();e.stopPropagation();selectText(b);const d=e.shiftKey?10:1;
  moveTextPadding(theme().bubble.padding,e.key==="ArrowLeft"?-d:e.key==="ArrowRight"?d:0,e.key==="ArrowUp"?-d:e.key==="ArrowDown"?d:0);refresh(false);
 });
 const guide=document.createElement("div");guide.className="bubble-wrap-guide hidden";
 const handle=b.querySelector(".bubble-resize");guide.append(handle);b.parentElement.append(guide);guide.addEventListener("click",e=>e.stopPropagation());
 handle.tabIndex=0;handle.setAttribute("role","slider");handle.setAttribute("aria-orientation","horizontal");handle.textContent="↔";
 handle.addEventListener("pointerdown",startBubbleWidthDrag);
 handle.addEventListener("keydown",e=>{
  if(!["ArrowLeft","ArrowRight"].includes(e.key))return;e.preventDefault();
  const id=bubbleWidthSetting(b),step=(e.shiftKey?10:1)*(e.key==="ArrowRight"?1:-1)*($("align").value==="right"?-1:1);
  $(id).value=clamp(val(id)+step,id==="donationWidth"?160:40,900);refresh(false);
 });
 b.querySelectorAll(".pad-handle").forEach(h=>{h.title=({left:"왼쪽",right:"오른쪽",top:"위",bottom:"아래"})[h.dataset.side]+" 안쪽 여백 조절"});
 b.querySelectorAll(".pad-handle").forEach(h=>h.addEventListener("pointerdown",startPaddingDrag))
});
$("frameEditbar").addEventListener("pointerdown",startFrameMove);$("frameResize").addEventListener("pointerdown",startFrameResize);

function dl(name,content,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
$("copyCss").onclick=async()=>{await navigator.clipboard.writeText($("output").value);$("copyCss").textContent="복사됨";setTimeout(()=>$("copyCss").textContent="CSS 복사",900)};
$("downloadCss").onclick=()=>dl("chat-theme.css",$("output").value,"text/css");
$("copyJson").onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify(theme(),null,2));$("copyJson").textContent="복사됨";setTimeout(()=>$("copyJson").textContent="Theme JSON 복사",900)};
$("downloadJson").onclick=()=>dl("chat-theme.json",JSON.stringify(theme(),null,2),"application/json");

function initialFramePosition(){
 const st=$("previewStage").getBoundingClientRect();
 const w=Math.min(820,Math.max(240,st.width-34));
 const h=Math.min(700,Math.max(320,st.height-82));
 $("frameWidth").value=Math.round(w);
 $("frameHeight").value=Math.round(h);
 $("frameX").value=14;
 $("frameY").value=50
}


function syncDragHelper(){
 const chip=$("dragHelperChip");if(!chip)return;
 chip.classList.add("hidden");
 if(!selected?.type)return;

 if(selected.type==="layer"){
  const el=document.querySelector(`.deco-layer[data-layer-id="${selected.id}"][data-instance="${selected.instance||0}"]`);
  if(el){
   const host=$("overlayFrame").getBoundingClientRect(),r=el.getBoundingClientRect();
   chip.textContent="이미지 · 잡아서 이동";
   chip.style.left=Math.max(6,r.left-host.left)+"px";
   chip.style.top=Math.max(6,r.top-host.top-28)+"px";
   chip.classList.remove("hidden")
  }
 }else if(selected.type==="tail"){
  const el=document.querySelectorAll(".tail-part")[selected.instance||0];
  if(el){
   const host=$("overlayFrame").getBoundingClientRect(),r=el.getBoundingClientRect();
   chip.textContent="꼬리 · 잡아서 이동";
   chip.style.left=Math.max(6,r.left-host.left)+"px";
   chip.style.top=Math.max(6,r.top-host.top-28)+"px";
   chip.classList.remove("hidden")
  }
 }else if(selected.type==="frame"){
   /* 제목 막대 자체가 이동 안내 역할을 하므로 중복 칩은 숨긴다. */
   chip.classList.add("hidden")
 }
}

function syncInspectorContext(){
 const type=selected?.type||null;
 document.querySelectorAll(".component-card").forEach(c=>c.classList.remove("selected-component"));
 const map={bubble:"bubble",text:"text",layer:"image",tail:"tail",frame:"layout"};
 const card=map[type]?document.querySelector(`.component-card[data-component="${map[type]}"]`):null;
 if(card)card.classList.add("selected-component")
}
const SETTINGS_INFO={
 bubble:["말풍선 상세 설정","안쪽 여백과 모서리를 각각 조절합니다."],
 pattern:["배경무늬 상세 설정","무늬 종류와 색상·진하기·크기를 조절합니다."],
 text:["글자 상세 설정","줄 높이, 굵기, 자간을 조절합니다."],
 layout:["배치 상세 설정","최대 폭, 간격, 채팅 영역 크기를 조절합니다."],
 image:["이미지 상세 설정","여기서 편집할 이미지를 고른 뒤 위치·크기·앞뒤 순서를 조절합니다."],
 tail:["말풍선 꼬리 상세 설정","꼬리 모양·크기·정확한 위치를 조절합니다."],
 display:["채팅 표시 상세 설정","닉네임의 색상·크기·간격을 조절합니다."],
 event:["후원·구독 상세 설정","알림 배경·테두리와 후원 박스 크기를 조절합니다."]
};
function openSettings(key){
 const modal=$("settingsModal");if(!modal)return;
 if(key==="image"&&decorations.length&&!selectedLayer())selectLayer(decorations[decorations.length-1].id,0);
 document.querySelectorAll("[data-settings-panel]").forEach(p=>p.classList.toggle("hidden",p.dataset.settingsPanel!==key));
 const info=SETTINGS_INFO[key]||["상세 설정","필요한 값을 세밀하게 조절하세요."];
 $("settingsTitle").textContent=info[0];$("settingsDesc").textContent=info[1];
 if(key==="image")renderModalLayerList();
 if(typeof modal.showModal==="function"){
  if(!modal.open)modal.showModal()
 }else{
  modal.setAttribute("open","")
 }
}
function closeSettings(){
 const modal=$("settingsModal");if(!modal)return;
 if(typeof modal.close==="function"&&modal.open)modal.close();
 else modal.removeAttribute("open")
}

let environmentChosen=false;
function chooseEnvironment(value){
 const adapter=$("adapter");if(!adapter)return;
 adapter.value=value;
 adapter.dispatchEvent(new Event("input",{bubbles:true}));
 environmentChosen=true;
 document.body.classList.remove("environment-pending");
 document.querySelectorAll("[data-adapter-choice]").forEach(b=>b.classList.toggle("active",b.dataset.adapterChoice===value));
 const exportHelp=$("exportTitle")?.nextElementSibling;
 if(exportHelp)exportHelp.textContent=value==="weflab"?"위플랩의 커스텀 CSS에 붙여 넣으세요. OBS에서 위플랩 주소를 사용하는 경우에도 같은 CSS를 사용합니다.":"직접 만든 HTML 채팅창에 적용하는 CSS입니다. CSS만으로 채팅이 수집되지는 않습니다.";
 const label=value==="weflab"?"위플랩":"직접 제작 HTML";
 const help=$("environmentHelp");if(help){help.textContent=value==="weflab"?"위플랩 채팅창에 적용합니다. OBS에서 위플랩 주소를 사용하는 경우도 선택하세요.":"직접 제작한 HTML 채팅창용입니다. 내보내는 CSS와 같은 요소 이름을 사용하는 HTML이 필요합니다.";help.classList.add("ready")}
 const gate=$("environmentGate");if(gate)gate.classList.add("hidden");
 const exportLabel=$("exportEnvironmentLabel");if(exportLabel)exportLabel.textContent=label
}


function syncPatternUi(){
 const preset=$("patternPreset")?$("patternPreset").value:"none";
 const color=$("patternColor")?$("patternColor").value:"#e9a9c0";
 const opacity=val("patternOpacity",26)/100,size=val("patternSize",18);
 if($("patternColorAdvanced"))$("patternColorAdvanced").value=color;
 document.querySelectorAll("[data-pattern-choice]").forEach(b=>b.classList.toggle("active",b.dataset.patternChoice===preset));
 const fake={bubble:{background:$("bgAdv")?$("bgAdv").value:"#fff4d2"},pattern:{preset,color,opacity,size}};
 const main=patternLayer(fake),pv=$("patternPreviewStrip");
 if(pv){pv.style.backgroundColor=fake.bubble.background;pv.style.backgroundImage=main.image;pv.style.backgroundSize=main.size;pv.style.backgroundPosition="0 0"}
 document.querySelectorAll(".pattern-swatch").forEach(b=>{
  const sw=b.querySelector("i");if(!sw)return;
  const p=patternLayer({bubble:fake.bubble,pattern:{preset:b.dataset.patternChoice,color,opacity,size}});
  sw.style.backgroundColor=fake.bubble.background;sw.style.backgroundImage=p.image;sw.style.backgroundSize=p.size;sw.style.backgroundPosition="0 0";
 });
}
function setupPatternUi(){
 const simple=$("patternColor"),advanced=$("patternColorAdvanced"),preset=$("patternPreset");
 if(simple)simple.addEventListener("input",()=>{if(advanced)advanced.value=simple.value;syncPatternUi()});
 if(advanced)advanced.addEventListener("input",()=>{if(simple)simple.value=advanced.value;syncPatternUi();refresh()});
 if(preset)preset.addEventListener("input",syncPatternUi);
 if($("patternOpacity"))$("patternOpacity").addEventListener("input",syncPatternUi);
 if($("patternSize"))$("patternSize").addEventListener("input",syncPatternUi);
 document.querySelectorAll("[data-pattern-choice]").forEach(b=>b.addEventListener("click",()=>{
  if(!preset)return;preset.value=b.dataset.patternChoice;preset.dispatchEvent(new Event("input",{bubbles:true}));syncPatternUi();refresh();
 }));
 syncPatternUi()
}
function setupFriendlyUi(){
 const guide=$("directEditGuide"),dismiss=$("guideDismiss");
 if(guide&&dismiss)dismiss.addEventListener("click",()=>{directGuideManuallyHidden=true;guide.classList.add("hidden")});
 const frame=$("overlayFrame");
 if(frame){
  frame.classList.add("guide-pulse");
  setTimeout(()=>frame.classList.remove("guide-pulse"),2600)
 }
 document.body.classList.add("environment-pending");
 document.querySelectorAll("[data-open-settings]").forEach(b=>b.addEventListener("click",()=>openSettings(b.dataset.openSettings)));

 const sm=$("settingsModal"),sc=$("settingsClose");
 if(sc)sc.addEventListener("click",closeSettings);
 if(sm)sm.addEventListener("click",e=>{
  const rect=sm.getBoundingClientRect();
  const inside=e.clientX>=rect.left&&e.clientX<=rect.right&&e.clientY>=rect.top&&e.clientY<=rect.bottom;
  if(!inside)closeSettings()
 });

 document.querySelectorAll("[data-adapter-choice]").forEach(b=>b.addEventListener("click",()=>chooseEnvironment(b.dataset.adapterChoice)));

 const apply=$("applyBtn"),em=$("exportModal"),ec=$("exportClose");
 if(apply&&em)apply.addEventListener("click",()=>{
  if(!environmentChosen){
   const card=$("environmentCard");if(card){card.scrollIntoView({behavior:"smooth",block:"start"});card.animate([{transform:"translateX(-4px)"},{transform:"translateX(4px)"},{transform:"translateX(0)"}],{duration:220})}
   return
  }
  em.classList.remove("hidden")
 });
 if(ec&&em)ec.addEventListener("click",()=>em.classList.add("hidden"));
 if(em)em.addEventListener("click",e=>{if(e.target===em)em.classList.add("hidden")});

 window.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
   if(sm&&sm.open)closeSettings();
   else if(em&&!em.classList.contains("hidden"))em.classList.add("hidden")
  }
 });
 syncInspectorContext()
}
function validateRequiredDom(){
 const missing=ids.filter(id=>!$(id));
 if(missing.length)console.error("[채팅창 꾸미기] 필수 화면 요소 누락:",missing);
 return missing
}
setupFriendlyUi();
setupPatternUi();
requestAnimationFrame(()=>{
 const missing=validateRequiredDom();
 initialFramePosition();
 refresh();
 selectFrame();
 window.__CHAT_THEME_READY__=missing.length===0
});

function runPlacementRegressionTests(){
 const results=[],eps=.75;
 const host=document.createElement("div");
 host.style.cssText="position:fixed;left:-5000px;top:-5000px;width:1px;height:1px;overflow:visible;";
 document.body.appendChild(host);

 const px=(r,n)=>n==="left"?r.left:n==="right"?r.right:r.left+r.width/2;
 const py=(r,n)=>n==="top"?r.top:n==="bottom"?r.bottom:r.top+r.height/2;
 const targetX=(r,n)=>n==="left"?r.left:n==="right"?r.right:r.left+r.width/2;
 const targetY=(r,n)=>n==="top"?r.top:n==="bottom"?r.bottom:r.top+r.height/2;
 const add=(name,delta)=>results.push({name,pass:Math.abs(delta)<=eps,delta});

 const xTargets=["left","center","right"],xSelfs=["left","center","right"];
 const yTargets=["top","center","bottom"],ySelfs=["top","center","bottom"];
 const sizes=[{w:180,h:72},{w:620,h:126}];

 for(const s of sizes){
  for(const t of xTargets)for(const self of xSelfs){
   const p=document.createElement("div"),c=document.createElement("div");
   p.style.cssText=`position:relative;width:${s.w}px;height:${s.h}px;`;
   c.style.cssText="position:absolute;width:56px;height:84px;";
   styleObj(c,anchorStyle({width:56,positionMode:"smart",xTarget:t,xSelf:self,yTarget:"top",ySelf:"top",xOffset:0,yOffset:0}));
   p.appendChild(c);host.appendChild(p);
   const pr=p.getBoundingClientRect(),cr=c.getBoundingClientRect();
   add(`X ${s.w} ${self}->${t}`,px(cr,self)-targetX(pr,t));
   p.remove()
  }
  for(const t of yTargets)for(const self of ySelfs){
   const p=document.createElement("div"),c=document.createElement("div");
   p.style.cssText=`position:relative;width:${s.w}px;height:${s.h}px;`;
   c.style.cssText="position:absolute;width:56px;height:84px;";
   styleObj(c,anchorStyle({width:56,positionMode:"smart",xTarget:"left",xSelf:"left",yTarget:t,ySelf:self,xOffset:0,yOffset:0}));
   p.appendChild(c);host.appendChild(p);
   const pr=p.getBoundingClientRect(),cr=c.getBoundingClientRect();
   add(`Y ${s.h} ${self}->${t}`,py(cr,self)-targetY(pr,t));
   p.remove()
  }
 }

 host.remove();
 const failed=results.filter(x=>!x.pass);
 document.body.dataset.selftest=failed.length?"fail":"pass";
 const pre=document.createElement("pre");
 pre.id="selftest-result";pre.style.display="none";
 pre.textContent=JSON.stringify({pass:!failed.length,total:results.length,failed});
 document.body.appendChild(pre);
 return{pass:!failed.length,total:results.length,failed}
}
if(new URLSearchParams(location.search).get("selftest")==="1"){
 requestAnimationFrame(()=>requestAnimationFrame(()=>runPlacementRegressionTests()))
}

// Width and padding are separate editing tools; neither imposes a shared fixed width.
document.querySelectorAll("[data-bubble-edit]").forEach(button=>button.addEventListener("click",()=>{
 cancelTextDrag();bubbleEditMode=button.dataset.bubbleEdit;syncBubbleEditing();
}));
$("bubbleWidthInput").addEventListener("input",e=>{
 if(e.target.value==="")return;const id=bubbleWidthSetting(activeBubble());$(id).value=clamp(+e.target.value,id==="donationWidth"?160:40,900);refresh(false);
});
$("bubbleWidthInput").addEventListener("change",e=>{e.target.value=val(bubbleWidthSetting(activeBubble()))});
document.querySelectorAll("[data-padding-input]").forEach(input=>{
 input.addEventListener("input",()=>{if(input.value==="")return;const value=clamp(+input.value,0,120);$(input.dataset.paddingInput).value=value;if($("linkPadding").checked)["padLeft","padRight","padTop","padBottom"].forEach(id=>$(id).value=value);refresh(false)});
 input.addEventListener("change",()=>input.value=val(input.dataset.paddingInput));
});
