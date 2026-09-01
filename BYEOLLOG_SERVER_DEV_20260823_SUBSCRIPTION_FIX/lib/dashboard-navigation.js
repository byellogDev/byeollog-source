export const DASHBOARD_NAV_ITEMS=Object.freeze([
  Object.freeze({key:'roulette',href:'/dashboard/roulette',label:'◉ 룰렛',title:'룰렛'}),
  Object.freeze({key:'signatures',href:'/dashboard/signatures',label:'✹ 시그풍',title:'시그풍'}),
  Object.freeze({key:'wallpaper',href:'/dashboard/wallpaper',label:'▦ 풍벽지',title:'풍벽지'}),
  Object.freeze({key:'actions',href:'/dashboard/actions',label:'✦ 액션',title:'액션'}),
  Object.freeze({key:'upbo',href:'/dashboard',label:'✓ 업보',title:'업보'})
]);

export function dashboardTitle(section){
  const item=DASHBOARD_NAV_ITEMS.find(candidate=>candidate.key===section)||DASHBOARD_NAV_ITEMS[0];
  return `별록 ${item.title}`;
}

export function dashboardNavigationHtml(activeSection){
  const links=DASHBOARD_NAV_ITEMS.map(item=>`<a${item.key===activeSection?' class="active"':''} href="${item.href}">${item.label}</a>`).join('');
  return `<nav class="productNav dashboardNav" aria-label="별록 대시보드">${links}</nav>`;
}

export function compactDashboardNavigation(html){
  const match=String(html).match(/<nav class="productNav dashboardNav" aria-label="별록 대시보드">[\s\S]*?<\/nav>/);
  return match?match[0].replace(/\s+/g,' ').replace(/> </g,'><').trim():'';
}
