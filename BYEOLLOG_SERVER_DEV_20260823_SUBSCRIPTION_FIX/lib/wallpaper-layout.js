export const WALLPAPER_CANVAS_WIDTH=1920;
export const WALLPAPER_CANVAS_HEIGHT=1080;
export const WALLPAPER_MAX_VISIBLE_TILES=216;
export const WALLPAPER_MIN_TILE_WIDTH=80;
export const WALLPAPER_MIN_TILE_HEIGHT=60;
export const WALLPAPER_EDITOR_MARGIN_X=0;
export const WALLPAPER_EDITOR_MARGIN_Y=0;
export const WALLPAPER_EDITOR_WIDTH=WALLPAPER_CANVAS_WIDTH+WALLPAPER_EDITOR_MARGIN_X*2;
export const WALLPAPER_EDITOR_HEIGHT=WALLPAPER_CANVAS_HEIGHT+WALLPAPER_EDITOR_MARGIN_Y*2;

export const WALLPAPER_CARD_WIDTH=240;
export const WALLPAPER_CARD_HEIGHT=226;
export const WALLPAPER_ROW_STEP=46;
export const WALLPAPER_COLUMN_GAP=0;

const CANVAS_MARGIN=0;
const GROUP_GAP=2;
const MAX_GROUP_COLUMNS=64;
const MAX_LAYOUT_COLUMNS=WALLPAPER_MAX_VISIBLE_TILES+1;

function positiveInteger(value,fallback){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:fallback;
}

function overlap(a,b,gap=0){
  return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;
}

function validCapacity(columns,rows){
  return Number.isSafeInteger(columns)&&columns>=1&&columns<=MAX_LAYOUT_COLUMNS
    &&Number.isSafeInteger(rows)&&rows>=1&&rows<=WALLPAPER_MAX_VISIBLE_TILES;
}

function columnsForRows(count,rows){
  return Math.ceil(count/rows);
}

function baseMetrics(count,columns,{rowsPerColumn=null,slotColumns=null,amounts=null,compact=false}={}){
  const safeCount=Math.max(1,Math.trunc(Number(count)||1));
  const safeColumns=Math.max(1,Math.min(safeCount,Math.trunc(Number(columns)||1),MAX_GROUP_COLUMNS));
  const safeRows=rowsPerColumn===null?Math.ceil(safeCount/safeColumns):Math.max(1,Math.min(WALLPAPER_MAX_VISIBLE_TILES,Math.trunc(Number(rowsPerColumn)||1)));
  const requiredColumns=Math.max(1,columnsForRows(safeCount,safeRows));
  const safeSlots=slotColumns===null?safeColumns:Math.max(requiredColumns,Math.min(MAX_LAYOUT_COLUMNS,Math.trunc(Number(slotColumns)||1)));
  return {
    columns:requiredColumns,slotColumns:Math.max(requiredColumns,safeSlots),rowsPerColumn:safeRows,
    width:safeSlots*WALLPAPER_CARD_WIDTH+Math.max(0,safeSlots-1)*WALLPAPER_COLUMN_GAP,
    height:(compact?WALLPAPER_ROW_STEP:WALLPAPER_CARD_HEIGHT)+Math.max(0,safeRows-1)*WALLPAPER_ROW_STEP
  };
}

export function automaticWallpaperGroupColumns(value){
  const count=Math.max(1,Math.trunc(Number(value)||1));
  if(count<=2)return 1;
  if(count<=6)return 2;
  if(count<=15)return 3;
  if(count<=30)return 4;
  if(count<=50)return 5;
  return 6;
}

export function fitWallpaperGroupCards(value,{width,height,columns=null,layoutColumns=null,layoutRows=null,amounts=null,direction='ltr',nextSide='right',compact=false}={}){
  const count=Math.max(1,Math.trunc(Number(value)||1));
  const targetWidth=Math.max(1,Number(width)||WALLPAPER_CARD_WIDTH);
  const targetHeight=Math.max(1,Number(height)||WALLPAPER_CARD_HEIGHT);
  let best=null;
  if(validCapacity(Number(layoutColumns),Number(layoutRows))){
    const rows=Math.trunc(Number(layoutRows)),requiredColumns=columnsForRows(count,rows);
    const base=baseMetrics(count,Math.min(requiredColumns,MAX_GROUP_COLUMNS),{rowsPerColumn:rows,slotColumns:Math.max(Number(layoutColumns),requiredColumns),amounts,compact});
    best={...base,scale:Math.min(targetWidth/base.width,targetHeight/base.height)};
  }else{
    const first=columns===null?1:Math.max(1,Math.min(count,Math.trunc(Number(columns)||1)));
    const last=columns===null?Math.min(count,MAX_GROUP_COLUMNS):first;
    for(let candidate=first;candidate<=last;candidate++){
      const base=baseMetrics(count,candidate,{amounts,compact});
      const scale=Math.min(targetWidth/base.width,targetHeight/base.height);
      if(!best||scale>best.scale+1e-9||(Math.abs(scale-best.scale)<1e-9&&candidate<best.columns))best={...base,scale};
    }
  }
  const cardWidth=Math.max(1,Math.floor(WALLPAPER_CARD_WIDTH*best.scale+1e-9));
  const cardHeight=Math.max(1,Math.floor((compact?WALLPAPER_ROW_STEP:WALLPAPER_CARD_HEIGHT)*best.scale));
  const rowStep=Math.max(1,Math.floor(WALLPAPER_ROW_STEP*best.scale));
  const columnGap=Math.max(0,Math.floor(WALLPAPER_COLUMN_GAP*best.scale));
  const usedColumns=Math.max(1,columnsForRows(count,best.rowsPerColumn));
  const slotColumns=Math.max(best.slotColumns,usedColumns);
  const safeNextSide=nextSide==='left'?'left':'right';
  const safeDirection=safeNextSide==='left'?'rtl':'ltr';
  const contentStart=safeNextSide==='left'?slotColumns-usedColumns:0;
  const contentWidth=slotColumns*cardWidth+Math.max(0,slotColumns-1)*columnGap;
  const contentHeight=cardHeight+Math.max(0,best.rowsPerColumn-1)*rowStep;
  const positions=new Array(count);
  for(let index=0;index<count;index++){
    const lane=Math.floor(index/best.rowsPerColumn),row=index%best.rowsPerColumn;
    const column=contentStart+(safeDirection==='rtl'?usedColumns-1-lane:lane);
    positions[index]={x:column*(cardWidth+columnGap),y:Math.max(0,targetHeight-cardHeight-row*rowStep),width:cardWidth,height:cardHeight,zIndex:row+1};
  }
  return {columns:usedColumns,slotColumns,rowsPerColumn:best.rowsPerColumn,scale:best.scale,cardWidth,cardHeight,rowStep,columnGap,contentWidth,contentHeight,direction:safeDirection,nextSide:safeNextSide,cards:positions};
}

export function validWallpaperTileLayout(value,{canvasWidth=WALLPAPER_CANVAS_WIDTH,canvasHeight=WALLPAPER_CANVAS_HEIGHT}={}){
  if(!value||typeof value!=='object')return false;
  const {x,y,width,height}=value;
  if(!([x,y,width,height].every(Number.isSafeInteger)
    &&x>=-WALLPAPER_EDITOR_MARGIN_X&&y>=-WALLPAPER_EDITOR_MARGIN_Y
    &&width>=WALLPAPER_MIN_TILE_WIDTH&&width<=canvasWidth+WALLPAPER_EDITOR_MARGIN_X*2
    &&height>=WALLPAPER_MIN_TILE_HEIGHT&&height<=canvasHeight+WALLPAPER_EDITOR_MARGIN_Y*2
    &&x+width<=canvasWidth+WALLPAPER_EDITOR_MARGIN_X
    &&y+height<=canvasHeight+WALLPAPER_EDITOR_MARGIN_Y))return false;
  return value.rows===undefined||(value.columns===null&&value.rows===null)||validCapacity(value.columns,value.rows);
}

export function groupWallpaperTiles(input){
  const groups=new Map();
  for(const tile of Array.isArray(input)?input:[]){
    const key=String(tile.groupKey||`${Number(tile.amount)||0}:${String(tile.source||'unknown')}`);
    let group=groups.get(key);
    if(!group){
      group={id:key,amount:Number(tile.amount)||0,displayKind:tile.displayKind||'donation',source:tile.source,imageUrl:tile.imageUrl,imageKey:tile.imageKey||null,tiles:[],layout:null,layer:Number.isSafeInteger(Number(tile.layout?.layer))?Number(tile.layout.layer):null,firstReceivedAt:tile.receivedAt||null,mergeRange:tile.mergeRange||null,direction:'ltr',nextSide:tile.layout?.nextSide||'right'};
      groups.set(key,group);
    }
    group.tiles.push(tile);
    if(!group.layout&&tile.layout){group.layout=tile.layout;group.nextSide=tile.layout.nextSide||group.nextSide;group.layer=Number.isSafeInteger(Number(tile.layout.layer))?Number(tile.layout.layer):group.layer}
  }
  return [...groups.values()].map(group=>{
    if(group.mergeRange)group.tiles.sort((a,b)=>Number(a.amount)-Number(b.amount)||Date.parse(a.receivedAt||0)-Date.parse(b.receivedAt||0)||String(a.id).localeCompare(String(b.id)));
    return {...group,tileIds:group.tiles.map(tile=>tile.id)};
  }).sort((a,b)=>(Number.isSafeInteger(a.layer)?a.layer:Number.MAX_SAFE_INTEGER)-(Number.isSafeInteger(b.layer)?b.layer:Number.MAX_SAFE_INTEGER));
}

function compactWallpaperGroup(group){
  return group.displayKind==='subscription'&&!group.tiles.some(tile=>Boolean(tile.imageUrl));
}

function sizeRuleForGroup(group,rules){
  if(group.displayKind!=='donation'||!Array.isArray(rules)||!group.tiles.length)return null;
  return rules.find(rule=>group.tiles.every(tile=>Number(tile.amount)>=Number(rule.min)&&Number(tile.amount)<=Number(rule.max)))||null;
}

function autoRectForGroup(group,scale,sizeRules=[]){
  const columns=automaticWallpaperGroupColumns(group.tiles.length),base=baseMetrics(group.tiles.length,columns,{compact:compactWallpaperGroup(group)});
  const rule=sizeRuleForGroup(group,sizeRules);
  if(rule){
    const requestedWidth=Math.max(WALLPAPER_MIN_TILE_WIDTH,Math.min(480,Math.trunc(Number(rule.width)||WALLPAPER_CARD_WIDTH)));
    const requestedScale=requestedWidth/WALLPAPER_CARD_WIDTH*scale;
    return {width:Math.max(WALLPAPER_MIN_TILE_WIDTH,Math.ceil(base.width*requestedScale)),height:Math.max(WALLPAPER_MIN_TILE_HEIGHT,Math.ceil(base.height*requestedScale)),columns};
  }
  return {width:Math.max(WALLPAPER_MIN_TILE_WIDTH,Math.floor(base.width*scale)),height:Math.max(WALLPAPER_MIN_TILE_HEIGHT,Math.floor(base.height*scale)),columns};
}

function firstFreeRect(rect,occupied,canvasWidth,canvasHeight){
  const maxX=canvasWidth-CANVAS_MARGIN-rect.width,maxY=canvasHeight-CANVAS_MARGIN-rect.height;
  if(maxX<CANVAS_MARGIN||maxY<CANVAS_MARGIN)return null;
  const xs=new Set([CANVAS_MARGIN]),ys=new Set([CANVAS_MARGIN]);
  for(const other of occupied){
    xs.add(other.x+other.width+GROUP_GAP);
    ys.add(other.y+other.height+GROUP_GAP);
  }
  const candidates=[];
  for(const y of ys)for(const x of xs)if(x>=CANVAS_MARGIN&&x<=maxX&&y>=CANVAS_MARGIN&&y<=maxY)candidates.push({x,y,width:rect.width,height:rect.height});
  candidates.sort((a,b)=>a.y-b.y||a.x-b.x);
  return candidates.find(candidate=>!occupied.some(other=>overlap(candidate,other,GROUP_GAP)))||null;
}

function placeAutomaticGroups(groups,occupied,canvasWidth,canvasHeight,sizeRules=[]){
  const ordered=[...groups].sort((a,b)=>b.tiles.length-a.tiles.length||String(a.id).localeCompare(String(b.id)));
  for(let scale=1;scale>=.16;scale-=.02){
    const trial=[...occupied],placements=new Map();let fits=true;
    for(const group of ordered){
      const rect=autoRectForGroup(group,scale,sizeRules),placed=firstFreeRect(rect,trial,canvasWidth,canvasHeight);
      if(!placed){fits=false;break}
      trial.push(placed);placements.set(group.id,{...placed,columns:rect.columns});
    }
    if(fits)return placements;
  }
  const placements=new Map();let x=CANVAS_MARGIN,y=CANVAS_MARGIN,rowHeight=0;
  for(const group of ordered){
    const rect=autoRectForGroup(group,.14,sizeRules);
    if(x+rect.width>canvasWidth-CANVAS_MARGIN){x=CANVAS_MARGIN;y+=rowHeight+GROUP_GAP;rowHeight=0}
    y=Math.min(Math.max(CANVAS_MARGIN,y),Math.max(CANVAS_MARGIN,canvasHeight-CANVAS_MARGIN-rect.height));
    placements.set(group.id,{x,y,width:rect.width,height:rect.height,columns:rect.columns});x+=rect.width+GROUP_GAP;rowHeight=Math.max(rowHeight,rect.height);
  }
  return placements;
}

function expandManualPlacementForNextColumn(group,placement,canvasWidth){
  const rows=Math.max(1,Math.trunc(Number(placement.rows)||1));
  const savedSlots=Math.max(1,Math.trunc(Number(placement.columns)||1));
  const requiredColumns=Math.max(1,columnsForRows(group.tiles.length,rows));
  const desiredSlots=Math.max(savedSlots,requiredColumns+1);
  if(desiredSlots===savedSlots)return placement;
  const desiredWidth=Math.max(placement.width,Math.round(placement.width*desiredSlots/savedSlots));
  if(group.nextSide==='left'){
    const right=placement.x+placement.width,x=Math.max(0,right-desiredWidth);
    return {...placement,x,width:right-x,columns:desiredSlots};
  }
  return {...placement,width:Math.min(desiredWidth,canvasWidth-placement.x),columns:desiredSlots};
}

export function layoutWallpaperGroups(input,{canvasWidth=WALLPAPER_CANVAS_WIDTH,canvasHeight=WALLPAPER_CANVAS_HEIGHT,sizeRanges=[]}={}){
  const width=positiveInteger(canvasWidth,WALLPAPER_CANVAS_WIDTH),height=positiveInteger(canvasHeight,WALLPAPER_CANVAS_HEIGHT);
  const source=Array.isArray(input)?input:[];
  const manual=source.filter(group=>validWallpaperTileLayout(group.layout,{canvasWidth:width,canvasHeight:height}));
  const occupied=manual.map(group=>group.layout);
  const automatic=source.filter(group=>!validWallpaperTileLayout(group.layout,{canvasWidth:width,canvasHeight:height}));
  const placements=placeAutomaticGroups(automatic,occupied,width,height,sizeRanges);
  return source.map((group,index)=>{
    const isManual=validWallpaperTileLayout(group.layout,{canvasWidth:width,canvasHeight:height});
    const placement=isManual?expandManualPlacementForNextColumn(group,group.layout,width):placements.get(group.id);
    const fitted=fitWallpaperGroupCards(group.tiles.length,{width:placement.width,height:placement.height,columns:isManual?null:placement.columns,layoutColumns:isManual?placement.columns:null,layoutRows:isManual?placement.rows:null,amounts:group.mergeRange?group.tiles.map(tile=>tile.amount):null,direction:group.direction,nextSide:group.nextSide,compact:compactWallpaperGroup(group)});
    return {...group,...placement,layer:Number.isSafeInteger(group.layer)&&group.layer>=1?group.layer:index+1,layoutColumns:isManual?fitted.slotColumns:null,layoutRows:isManual?fitted.rowsPerColumn:null,manualLayout:isManual,...fitted,cards:group.tiles.map((tile,index)=>({...tile,...fitted.cards[index]}))};
  });
}

export function wallpaperGroupsDoNotOverlap(groups){
  const list=Array.isArray(groups)?groups:[];
  for(let left=0;left<list.length;left++){
    const a=list[left];
    if(a.x<0||a.y<0||a.width<1||a.height<1||a.x+a.width>WALLPAPER_CANVAS_WIDTH||a.y+a.height>WALLPAPER_CANVAS_HEIGHT)return false;
    for(let right=left+1;right<list.length;right++)if(overlap(a,list[right]))return false;
  }
  return true;
}
