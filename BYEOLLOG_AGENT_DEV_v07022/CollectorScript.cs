namespace HurogiCollector;

internal static class CollectorScript
{
    public static string Build(DateTime broadcastStartLocal, int intervalMs = 10000)
    {
        var start = broadcastStartLocal.ToString("yyyyMMddHHmm");
        return $$"""
(function(){
  try {
    if (window.__hurogi_poll__) clearInterval(window.__hurogi_poll__);
    if (window.__hurogi_login_watch__) clearInterval(window.__hurogi_login_watch__);
    if (window.__hurogi_bootstrap_timer__) clearTimeout(window.__hurogi_bootstrap_timer__);

    function post(o){ try { window.chrome.webview.postMessage(JSON.stringify(o)); } catch(e) {} }
    function p2(n){ return (n < 10 ? '0' : '') + n; }
    function stamp(d){ return d.getFullYear()+p2(d.getMonth()+1)+p2(d.getDate())+p2(d.getHours())+p2(d.getMinutes()); }
    function parseStamp(s){ return new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8), +s.slice(8,10), +s.slice(10,12), 0, 0); }
    function loggedIn(){
      return typeof loginData !== 'undefined' && loginData && loginData.idx != null && String(loginData.idx) !== '-1' && String(loginData.idx) !== '0';
    }

    var broadcastStart = parseStamp('{{start}}');
    function requestRange(from,to,done){
      if (!loggedIn()) { post({kind:'status', state:'nologin', text:'로그인이 필요함'}); if(done)done(false); return; }
      if (typeof $ === 'undefined' || !$.ajax) { post({kind:'status', state:'error', text:'jQuery를 찾지 못함'}); if(done)done(false); return; }
      $.ajax({
        type:'POST', url:'/api/', cache:false, dataType:'json',
        data:{
          type:'alertlist_load', pagetype:'setup', idx:loginData.idx,
          pageid:'alertlist', preset:(loginData.preset == null ? '0' : loginData.preset),
          ver:(loginData.config&&loginData.config.ver!=null?loginData.config.ver:''), lastdate:'',
          filter:{ start:stamp(from), end:stamp(to), min:'', type:'all', search:'' }
        },
        success:function(r){
          post({kind:'rows', payload:r});
          if(done)done(true);
        },
        error:function(x){ post({kind:'status', state:'error', text:'후원내역 조회 실패 (' + x.status + ')'}); if(done)done(false); }
      });
    }

    // 처음 실행할 때는 방송 시작~현재를 30분 단위로 나눠 조회합니다.
    // API가 한 응답에 표시할 수 있는 건수 제한이 있어도 장시간 방송 기록 누락을 줄입니다.
    function bootstrap(){
      var now = new Date(Date.now()+60000), cursor = new Date(broadcastStart.getTime());
      function next(){
        if (cursor >= now) { post({kind:'status',state:'activity',text:'초기 구간 확인 완료'}); return; }
        var end = new Date(Math.min(now.getTime(), cursor.getTime()+30*60000));
        requestRange(cursor,end,function(ok){
          if (ok) cursor = new Date(end.getTime());
          // 실패한 구간은 건너뛰지 않고 같은 구간을 다시 요청합니다.
          // 로그인 해제/일시적 HTTP 오류가 있어도 과거 30분이 영구 누락되지 않습니다.
          window.__hurogi_bootstrap_timer__=setTimeout(next, ok ? 180 : 2500);
        });
      }
      next();
    }

    // 실시간은 최근 60분을 겹쳐 조회합니다. UID 중복 제거가 있으므로 중복 저장되지 않습니다.
    var tickBusy = false;
    function tick(){
      if (tickBusy) return;
      tickBusy = true;
      var to = new Date(Date.now()+60000);
      var from = new Date(Math.max(broadcastStart.getTime(), Date.now()-60*60000));
      requestRange(from,to,function(){ tickBusy = false; });
    }

    var __lastLoginState = null;
    window.__hurogi_login_watch__ = setInterval(function(){
      var nowLogged = loggedIn();
      if (nowLogged !== __lastLoginState) {
        __lastLoginState = nowLogged;
        post(nowLogged ? {kind:'status', state:'auth_on', text:'위플랩 로그인 후보 확인'} : {kind:'status', state:'nologin', text:'로그인이 필요함'});
      }
    }, 2000);
    window.__hurogi_poll__ = setInterval(tick, {{intervalMs}});
    bootstrap();
    tick();
    post({kind:'status', state:'waiting', text:'방송 구간 수집 시작 · {{start}}~'});
  } catch(e) {
    try { window.chrome.webview.postMessage(JSON.stringify({kind:'status',state:'error',text:String(e)})); } catch(_) {}
  }
})();
""";
    }
}
