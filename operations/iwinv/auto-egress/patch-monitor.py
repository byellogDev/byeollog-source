"""Guarded monitor integration. Does not send notifications when preparing."""
import inspect
import pathlib
import sys


def capture_auto_egress(value, now):
    value = value if isinstance(value, dict) else {}
    at = value.get('at')
    known = {'api_http_401', 'api_http_403', 'api_http_429', 'api_unavailable', 'api_rejected',
             'rule_capacity', 'creation_rate_limit', 'create_outcome_unknown', 'baseline_drift',
             'owned_rule_drift', 'owned_rule_missing', 'owned_rule_ambiguous', 'unreviewed_rule_drift',
             'instance_association_drift', 'connection_observation_stale', 'chatinfo_dns_mismatch',
             'chatinfo_owner_mismatch', 'invalid_destination', 'controller_maintenance_failed',
             'controller_request_failed', 'rules_incomplete', 'delete_outcome_pending'}
    code = value.get('lastError')
    if type(at) not in (int, float) or not -5 <= now-at <= 90: code = 'controller_stale'
    elif code is not None and code not in known: code = 'controller_error'
    count = value.get('ownedCount')
    return {'error': code, 'needsReview': value.get('needsReview') is True,
            'ownedCount': count if type(count) == int and 0 <= count <= 24 else None}


def auto_egress_detail(opened, detail):
    detail = detail if isinstance(detail, dict) else {}
    code = detail.get('error')
    labels = {'api_http_401': 'API 인증 실패', 'api_http_403': 'API 권한 또는 호출 IP 제한',
              'api_http_429': 'API 호출 한도 초과', 'api_unavailable': 'API 응답 실패',
              'rule_capacity': '자동 규칙 개수 한도 도달', 'creation_rate_limit': '규칙 생성 속도 제한',
              'create_outcome_unknown': '규칙 생성 결과 불명확: 중복 생성 중지',
              'controller_stale': '자동 제어기 상태 갱신 중단',
              'connection_observation_stale': '활성 연결 확인 불가: 유휴 규칙 삭제 보류',
              'chatinfo_dns_mismatch': '숲 접속 정보와 DNS 불일치',
              'chatinfo_owner_mismatch': '숲 접속 계정 불일치'}
    if not opened: return '\n확인: 자동 허용 제어기의 후속 점검이 정상입니다. 실제 수집 연결 복구는 채널 상태로 별도 확인합니다.'
    reason = labels.get(code, '자동 허용 제어기 점검 필요')
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
