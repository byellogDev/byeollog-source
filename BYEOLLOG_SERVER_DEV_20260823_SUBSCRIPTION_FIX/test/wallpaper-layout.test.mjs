import test from 'node:test';
import assert from 'node:assert/strict';
import {WALLPAPER_ROW_STEP,automaticWallpaperGroupColumns,fitWallpaperGroupCards,groupWallpaperTiles,layoutWallpaperGroups,validWallpaperTileLayout,wallpaperGroupsDoNotOverlap} from '../lib/wallpaper-layout.js';

function tile(id,amount,groupKey,layout=null){
  return {id,amount,groupKey,source:'soop',imageUrl:`https://example.com/${groupKey}.png`,actorName:`후원자${id}`,receivedAt:`2026-08-30T00:00:${String(id).padStart(2,'0')}Z`,layout};
}

test('same wallpaper identity becomes one video-style group with stacked donor rows',()=>{
  const groups=groupWallpaperTiles([tile(1,77,'same'),tile(2,77,'same'),tile(3,77,'same'),tile(4,10,'other')]);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].tileIds,[1,2,3]);
  const laidOut=layoutWallpaperGroups(groups);
  assert.equal(laidOut[0].cards.length,3);
  assert.ok(laidOut[0].cards[1].y<laidOut[0].cards[0].y||laidOut[0].cards[1].x>laidOut[0].cards[0].x);
  assert.equal(new Set(laidOut[0].cards.map(card=>card.imageUrl)).size,1);
});

test('subscription wallpaper uses compact text-only cards and keeps month groups separate',()=>{
  const subscriptions=[1,2].map(id=>({
    ...tile(id,6,'wallpaper-subscription-6'),
    displayKind:'subscription',source:'none',imageUrl:null,imageKey:null
  }));
  const [group]=layoutWallpaperGroups(groupWallpaperTiles(subscriptions));
  assert.equal(group.displayKind,'subscription');
  assert.equal(group.cards.length,2);
  assert.ok(group.cards.every(card=>card.imageUrl===null));
  assert.equal(group.cardHeight,group.rowStep);
  assert.ok(group.height<=WALLPAPER_ROW_STEP*2);
});

test('subscription wallpaper uses normal image-card proportions when SOOP supplies an official image',()=>{
  const subscriptions=[1,2].map(id=>({
    ...tile(id,3,'wallpaper-subscription-3'),
    displayKind:'subscription',source:'soop',
    imageUrl:'https://static.file.sooplive.com/subscription_ceremony/m/gudok_3.png',
    imageKey:'soop:https://static.file.sooplive.com/subscription_ceremony/m/gudok_3.png'
  }));
  const [group]=layoutWallpaperGroups(groupWallpaperTiles(subscriptions));
  assert.equal(group.displayKind,'subscription');
  assert.ok(group.cards.every(card=>card.imageUrl?.includes('/subscription_ceremony/')));
  assert.ok(group.cardHeight>group.rowStep);
  assert.ok(group.height>WALLPAPER_ROW_STEP*2);
});

test('columns touch, cards fill from the lower left, and a saved next column stays reserved',()=>{
  const fitted=fitWallpaperGroupCards(10,{width:960,height:500,layoutColumns:4,layoutRows:4});
  assert.equal(fitted.columns,3);
  assert.equal(fitted.slotColumns,4);
  assert.equal(fitted.columnGap,0);
  assert.ok(fitted.cards[0].y>fitted.cards[1].y);
  assert.equal(fitted.cards[4].x,fitted.cardWidth);
  assert.equal(fitted.cards[8].x,fitted.cardWidth*2);
  assert.ok(fitted.contentWidth<=960);
});

test('fixed card widths round-trip through saved area rows and columns',()=>{
  for(const compact of [false,true])for(const cardWidth of [80,181,240,333,480])for(const rows of [1,7,15]){
    const count=Math.min(30,rows*3),slotColumns=Math.ceil(count/rows)+1;
    const baseHeight=(compact?46:226)+Math.max(0,rows-1)*46;
    const width=slotColumns*cardWidth,height=Math.max(60,Math.ceil(baseHeight*cardWidth/240));
    const fitted=fitWallpaperGroupCards(count,{width,height,layoutColumns:slotColumns,layoutRows:rows,compact});
    assert.equal(fitted.cardWidth,cardWidth,`${compact?'compact':'image'} ${cardWidth}px × ${rows} rows`);
    assert.equal(fitted.rowsPerColumn,rows);
    assert.equal(fitted.slotColumns,slotColumns);
  }
});

test('clicking the next-column side flips card stacking to the opposite lower corner',()=>{
  const right=fitWallpaperGroupCards(10,{width:960,height:500,layoutColumns:4,layoutRows:4,nextSide:'right'});
  const left=fitWallpaperGroupCards(10,{width:960,height:500,layoutColumns:4,layoutRows:4,nextSide:'left'});
  assert.equal(right.nextSide,'right');
  assert.equal(right.direction,'ltr');
  assert.equal(right.cards[0].x,0);
  assert.equal(left.nextSide,'left');
  assert.equal(left.direction,'rtl');
  assert.equal(left.cards[0].x,left.cardWidth*3);
  assert.equal(left.cards[8].x,left.cardWidth);
});

test('merged amount ranges share one continuous vertical stack ordered only by amount and time',()=>{
  const mergeRange={min:1,max:3};
  const input=[
    {...tile(1,1,'merged'),mergeRange},{...tile(2,1,'merged'),mergeRange},
    {...tile(3,2,'merged'),mergeRange},{...tile(4,3,'merged'),mergeRange}
  ];
  const [group]=groupWallpaperTiles(input);
  assert.deepEqual(group.mergeRange,mergeRange);
  assert.equal(group.direction,'ltr');
  assert.equal(group.nextSide,'right');
  const [laidOut]=layoutWallpaperGroups([group]);
  assert.equal(laidOut.cards.length,4);
  assert.equal(laidOut.cards[0].amount,1);
  assert.equal(laidOut.cards[1].amount,1);
  assert.equal(laidOut.cards[2].amount,2);
  assert.equal(laidOut.cards[3].amount,3);
  assert.equal(laidOut.cards[0].x,laidOut.cards[1].x);
  assert.ok(laidOut.cards[0].y>laidOut.cards[1].y);
  const left=fitWallpaperGroupCards(4,{width:960,height:500,layoutColumns:4,layoutRows:2,amounts:[1,1,2,3],nextSide:'left'});
  assert.equal(left.direction,'rtl');
  assert.equal(left.columns,2);
  assert.equal(left.cards[0].x,left.cards[1].x);
  assert.ok(left.cards[0].x>left.cards[2].x);
});

test('a merge range never starts a new column merely because the donation amount changed',()=>{
  const fitted=fitWallpaperGroupCards(7,{width:720,height:500,layoutColumns:3,layoutRows:3,amounts:[1,1,2,3,5,7,9],nextSide:'right'});
  assert.equal(fitted.columns,3);
  assert.deepEqual(fitted.cards.map(card=>card.x),[
    0,0,0,fitted.cardWidth,fitted.cardWidth,fitted.cardWidth,fitted.cardWidth*2
  ]);
});

test('resizing a group automatically reflows cards between rows and columns',()=>{
  const wide=fitWallpaperGroupCards(12,{width:1920,height:240});
  const compact=fitWallpaperGroupCards(12,{width:720,height:720});
  const narrow=fitWallpaperGroupCards(12,{width:260,height:1080});
  assert.ok(wide.columns>compact.columns);
  assert.ok(compact.columns>narrow.columns);
  assert.equal(wide.cards.length,12);
  assert.ok(wide.contentWidth<=1920&&wide.contentHeight<=240);
  assert.ok(compact.contentWidth<=720&&compact.contentHeight<=720);
  assert.ok(narrow.contentWidth<=260&&narrow.contentHeight<=1080);
  assert.equal(fitWallpaperGroupCards(1,{width:960,height:904}).scale,4);
});

test('automatic group layout is deterministic, bounded, and non-overlapping',()=>{
  const tiles=[];let id=1;
  for(const [groupKey,count] of [['a',75],['b',37],['c',22],['d',9],['e',4],['f',3],['g',2],['h',1]]){
    for(let index=0;index<count;index++)tiles.push(tile(id++,count,groupKey));
  }
  const grouped=groupWallpaperTiles(tiles),first=layoutWallpaperGroups(grouped),second=layoutWallpaperGroups(grouped);
  assert.deepEqual(first,second);
  assert.equal(first.length,8);
  assert.ok(first.every(group=>validWallpaperTileLayout(group)));
  assert.ok(wallpaperGroupsDoNotOverlap(first));
  assert.equal(automaticWallpaperGroupColumns(75),6);
  assert.deepEqual([first[0].x,first[0].y],[0,0]);
});

test('saved amount ranges set the card width for automatic donation groups',()=>{
  const groups=groupWallpaperTiles([
    tile(1,33,'thirty-three'),
    tile(2,33,'thirty-three'),
    tile(3,150,'one-fifty')
  ]);
  const laidOut=layoutWallpaperGroups(groups,{sizeRanges:[
    {min:1,max:99,width:180},
    {min:100,max:999,width:300}
  ]});
  assert.equal(laidOut.find(group=>group.id==='thirty-three').cardWidth,180);
  assert.equal(laidOut.find(group=>group.id==='one-fifty').cardWidth,300);
  assert.ok(wallpaperGroupsDoNotOverlap(laidOut));
});

test('saved group layout is inherited by a new donation in the same group',()=>{
  const saved={x:300,y:200,width:720,height:520,columns:3,rows:2};
  const groups=groupWallpaperTiles([tile(1,33,'roulette',saved),tile(2,33,'roulette',saved),tile(3,33,'roulette')]);
  const [group]=layoutWallpaperGroups(groups);
  assert.equal(group.manualLayout,true);
  assert.deepEqual([group.x,group.y,group.width,group.height],[300,200,720,520]);
  assert.equal(group.cards.length,3);
  assert.equal(group.slotColumns,3);
  assert.equal(group.rowsPerColumn,2);
  assert.ok(group.cards.every(card=>card.x>=0&&card.y>=0));
});

test('a donation entering the reserved next column grows the group and reserves a new column',()=>{
  const rightLayout={x:100,y:200,width:480,height:500,columns:2,rows:2,nextSide:'right'};
  const [right]=layoutWallpaperGroups(groupWallpaperTiles([
    tile(1,50,'right',rightLayout),tile(2,50,'right',rightLayout),tile(3,50,'right')
  ]));
  assert.deepEqual([right.x,right.width,right.slotColumns],[100,720,3]);
  assert.equal(Math.max(...right.cards.map(card=>card.x)),right.cardWidth);
  assert.ok(right.width<=1920-right.x);

  const leftLayout={x:600,y:200,width:480,height:500,columns:2,rows:2,nextSide:'left'};
  const [left]=layoutWallpaperGroups(groupWallpaperTiles([
    tile(4,50,'left',leftLayout),tile(5,50,'left',leftLayout),tile(6,50,'left')
  ]));
  assert.deepEqual([left.x,left.width,left.slotColumns],[360,720,3]);
  assert.equal(left.x+left.width,1080);
  assert.equal(Math.min(...left.cards.map(card=>card.x)),left.cardWidth);
});

test('manual wallpaper groups preserve intentionally overlapping rectangles',()=>{
  const first={x:100,y:100,width:600,height:400,columns:3,rows:2};
  const second={x:300,y:250,width:600,height:400,columns:3,rows:2};
  const groups=groupWallpaperTiles([tile(1,10,'first',first),tile(2,20,'second',second)]);
  const laidOut=layoutWallpaperGroups(groups);
  assert.deepEqual(laidOut.map(group=>[group.x,group.y,group.width,group.height]),[
    [100,100,600,400],[300,250,600,400]
  ]);
  assert.equal(laidOut.every(group=>group.manualLayout),true);
  assert.equal(wallpaperGroupsDoNotOverlap(laidOut),false);
});

test('saved off-canvas layout is rejected and falls back inside the OBS frame',()=>{
  const layout={x:-80,y:-45,width:600,height:420,columns:3,rows:2,nextSide:'right'};
  const [group]=layoutWallpaperGroups(groupWallpaperTiles([tile(1,50,'off-canvas',layout)]));
  assert.equal(group.manualLayout,false);
  assert.ok(validWallpaperTileLayout(group));
  assert.equal(validWallpaperTileLayout({x:0,y:0,width:80,height:60}),true);
  assert.equal(validWallpaperTileLayout({x:-1,y:0,width:80,height:60}),false);
  assert.equal(validWallpaperTileLayout({x:1840,y:1020,width:80,height:60}),true);
  assert.equal(validWallpaperTileLayout({x:1841,y:1020,width:80,height:60}),false);
});

test('invalid manual layout falls back to automatic placement',()=>{
  const groups=groupWallpaperTiles([tile(1,1,'invalid',{x:1900,y:1000,width:240,height:226})]);
  const [group]=layoutWallpaperGroups(groups);
  assert.equal(group.manualLayout,false);
  assert.ok(validWallpaperTileLayout(group));
  assert.equal(validWallpaperTileLayout({x:0,y:0,width:80,height:60}),true);
  assert.equal(validWallpaperTileLayout({x:0,y:0,width:79,height:60}),false);
});
