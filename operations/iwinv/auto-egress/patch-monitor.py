"""Guarded monitor integration. Does not send notifications when preparing."""
import inspect
import pathlib
import sys


def capture_auto_egress(value, now):
    value = value if isinstance(value, dict) else {}
    at = value.get('at')
    known = {'api_http_401', 'api_http_403', 'api_http_429',
             'api_http_500', 'api_http_502', 'api_http_503', 'api_http_504',
             'api_unavailable', 'api_rejected',
             'rule_capacity', 'creation_rate_limit', 'create_outcome_unknown', 'baseline_drift',
             'owned_rule_drift', 'owned_rule_missing', 'owned_rule_ambiguous', 'unreviewed_rule_drift',
             'instance_association_drift', 'connection_observation_stale', 'chatinfo_dns_mismatch',
             'chatinfo_owner_mismatch', 'invalid_destination', 'controller_maintenance_failed',
             'controller_request_failed', 'rules_incomplete', 'delete_outcome_pending'}
    code = value.get('lastError')
    if type(at) not in (int, float) or not -5 <= now-at <= 90: code = 'controller_stale'
    elif code is not None and code not in known: code = 'controller_error'
    elif code is None and value.get('diagnosticsHealthy') is False: code = 'diagnostics_unavailable'
    count = value.get('ownedCount')
    api=value.get('lastApi')
    failure=None
    if (code=='api_unavailable' and isinstance(api,dict) and api.get('outcome')=='api_unavailable'
            and type(api.get('at')) in (int,float) and -5<=now-api['at']<=90):
        kind=api.get('failureKind')
        if kind in ('timeout','dns','tls','connection','incomplete_response','invalid_json','os_error','unexpected'):
            failure={'kind':kind}
            if api.get('phase') in ('connect','read','decode'):failure['phase']=api['phase']
            if api.get('networkPhase') in ('tcp_dns','tls_or_tunnel','response_headers','response_body','decode'):
                failure['networkPhase']=api['networkPhase']
            elapsed=api.get('elapsedMs')
            if type(elapsed)==int and 0<=elapsed<=120000:failure['elapsedMs']=elapsed
    return {'error': code, 'needsReview': value.get('needsReview') is True,
            'apiFailure':failure,
            'ownedCount': count if type(count) == int and 0 <= count <= 24 else None}


def auto_egress_detail(opened, detail):
    detail = detail if isinstance(detail, dict) else {}
    code = detail.get('error')
    labels = {'api_http_401': 'API 인증 실패', 'api_http_403': 'API 권한 또는 호출 IP 제한',
              'api_http_429': 'API 호출 한도 초과', 'api_unavailable': 'API 응답 실패',
              'api_http_500': '클라우드 API 서버 오류 (HTTP 500)',
              'api_http_502': '클라우드 API 게이트웨이 오류 (HTTP 502)',
              'api_http_503': '클라우드 API 서비스 사용 불가 (HTTP 503)',
              'api_http_504': '클라우드 API 게이트웨이 시간 초과 (HTTP 504)',
              'diagnostics_unavailable': '자동 제어기 상세 로그 저장 실패',
              'rule_capacity': '자동 규칙 개수 한도 도달', 'creation_rate_limit': '규칙 생성 속도 제한',
              'create_outcome_unknown': '규칙 생성 결과 불명확: 중복 생성 중지',
              'controller_stale': '자동 제어기 상태 갱신 중단',
              'connection_observation_stale': '활성 연결 확인 불가: 유휴 규칙 삭제 보류',
              'chatinfo_dns_mismatch': '숲 접속 정보와 DNS 불일치',
              'chatinfo_owner_mismatch': '숲 접속 계정 불일치'}
    if not opened: return '\n확인: 자동 허용 제어기의 후속 점검이 정상입니다. 실제 수집 연결 복구는 채널 상태로 별도 확인합니다.'
    reason = labels.get(code, '자동 허용 제어기 점검 필요')
    failure=detail.get('apiFailure')
    if code=='api_unavailable' and isinstance(failure,dict):
        reasons={'timeout':'API 응답 시간 초과','dns':'API 주소 DNS 조회 실패',
                 'tls':'API TLS 연결 실패','connection':'API 연결 끊김',
                 'incomplete_response':'API 응답 중간 끊김','invalid_json':'API 응답 형식 오류',
                 'os_error':'API 연결 OS 오류','unexpected':'API 요청 처리 예외'}
        reason=reasons.get(failure.get('kind'),reason)
        phases={'connect':'연결·응답 헤더 대기','read':'응답 본문 읽기','decode':'응답 해석'}
        network={'tcp_dns':'DNS·TCP 연결','tls_or_tunnel':'TLS·터널 연결',
                 'response_headers':'HTTP 응답 헤더 대기','response_body':'응답 본문 읽기','decode':'응답 해석'}
        stage=network.get(failure.get('networkPhase'),phases.get(failure.get('phase')))
        if stage:reason+=' / '+stage
        elapsed=failure.get('elapsedMs')
        if type(elapsed)==int and 0<=elapsed<=120000:reason+=' / '+str(round(elapsed/1000,1))+'초'
    if detail.get('needsReview') is True: reason += ' / 방화벽 규칙 변경 감지로 자동 변경 중지'
    return '\n내용: '+reason+'\n영향: 이미 허용된 포트의 수집은 유지하며, 새 목적지 허용이나 유휴 규칙 정리가 보류될 수 있습니다.\n조치: API 권한·규칙 변경·제어기 상태를 확인하세요. 자동 안전 중단은 우회하지 않습니다.'


def patch(source):
    if 'def capture_auto_egress(' in source: raise ValueError('monitor_auto_egress_already_applied')
    def once(old, new):
        nonlocal source
        if source.count(old) != 1: raise ValueError('monitor_auto_egress_source_drift')
        source = source.replace(old, new, 1)
    once('def advance_alerts(', inspect.getsource(capture_auto_egress)+'\n\n'+inspect.getsource(auto_egress_detail)+
         "\n\nLABELS['auto_egress']='SOOP 자동 출발 통신 제어 이상'\n\ndef advance_alerts(")
    once('        is_bad=key in bad\n', "        if key=='auto_egress' and sample is not None:\n            a['autoEgressDetail']=sample.get('autoEgress',{})\n        is_bad=key in bad\n")
    once("        content+=connection_alert_detail(key,p['open'],a.get('connectionDetail',{'ports':a.get('ports',[])}))\n",
         "        content+=connection_alert_detail(key,p['open'],a.get('connectionDetail',{'ports':a.get('ports',[])}))\n        if key=='auto_egress':content+=auto_egress_detail(p['open'],a.get('autoEgressDetail'))\n")
    once('    return sample,bad\n', "    if pathlib.Path('/etc/byeollog-egress/enabled').exists():\n        try:auto=read_json('/var/lib/byeollog-egress/status.json')\n        except Exception:auto={}\n        sample['autoEgress']=capture_auto_egress(auto,now)\n        if sample['autoEgress']['error'] or sample['autoEgress']['needsReview']:bad.add('auto_egress')\n    return sample,bad\n")
    compile(source, 'auto-egress-monitor', 'exec')
    return source


if __name__ == '__main__':
    pathlib.Path(sys.argv[2]).write_text(patch(pathlib.Path(sys.argv[1]).read_text(encoding='utf8')), encoding='utf8')
