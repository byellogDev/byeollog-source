"""Add bounded, evidence-based Discord details to the deployed monitor."""
import inspect
import pathlib
import sys


def capture_connection_detail(sample):
    sample = sample if isinstance(sample, dict) else {}
    ports = sample.get('unapprovedEgressPorts')
    reasons = sample.get('channelHealthReasons')
    errors = sample.get('channelErrors')
    return {
        'ports': sorted({p for p in ports if type(p) == int and 1 <= p <= 65535})[:16] if isinstance(ports, list) else [],
        'reasons': [r for r in ('connection_not_ready', 'worker_stale', 'channel_telemetry_invalid', 'failed_channel_missing') if isinstance(reasons, list) and r in reasons],
        'errors': min(errors, 1000) if type(errors) == int and errors >= 0 else None,
    }


def connection_alert_detail(key, opened, detail):
    detail = detail if isinstance(detail, dict) else {}
    # Revalidate persisted state; arbitrary strings never become Discord content.
    safe = capture_connection_detail({'unapprovedEgressPorts': detail.get('ports'),
                                     'channelHealthReasons': detail.get('reasons'), 'channelErrors': detail.get('errors')})
    ports = ', '.join(str(p) for p in safe['ports'])
    if key == 'egress_policy':
        if not opened:
            return '\n확인: 등록된 허용 정책에서 미허용 포트가 해소됐습니다. 수집 연결 복구 여부는 채널 상태 알림으로 별도 확인합니다.'
        return ('\n내용: 등록된 출발 통신 허용 목록 밖의 TCP 포트를 관측했습니다.'
                + ('\n대상 포트: TCP ' + ports if ports else '\n대상 포트: 확인 자료 없음')
                + '\n원인 판정: 허용 정책 불일치이며 실제 방화벽 차단 여부는 추가 확인이 필요합니다.'
                + '\n조치: 숲이 할당한 접속 정보와 방화벽 규칙을 대조하고, 필요한 목적지·포트만 허용한 뒤 재연결을 확인하세요.')
    if key == 'channel_state':
        if not opened:
            return '\n확인: 신선한 상태 기록 두 건에서 연결 완료 또는 방송 종료를 확인했습니다.'
        names = {'connection_not_ready': '연결 실패 또는 재시도 후 연결 완료 미확인',
                 'worker_stale': '수집 상태 기록 갱신 중단', 'channel_telemetry_invalid': '채널 상태 기록 누락·형식 오류',
                 'failed_channel_missing': '실패했던 채널의 후속 상태 기록 누락'}
        reason = ' / '.join(names[r] for r in safe['reasons']) or '연결 상태 이상, 상세 원인 미확정'
        return ('\n내용: ' + reason
                + ('\n오류 채널: ' + str(safe['errors']) + '개' if safe['errors'] is not None else '')
                + ('\n함께 관측된 미허용 TCP 포트: ' + ports + ' (이 채널의 직접 원인인지는 미확정)' if ports else '\n미허용 포트 근거: 현재 없음. 포트 차단으로 단정할 수 없습니다.')
                + '\n조치: 접속 대상·연결 오류·인증 상태를 확인하세요. 재시도 중에는 복구로 처리하지 않습니다.')
    if key == 'egress_observation':
        return ('\n내용: 수집기의 외부 TCP 연결 상태를 조회하지 못했습니다. 포트 허용 여부는 판정할 수 없습니다.'
                '\n조치: 호스트의 네트워크 상태 조회 도구와 실행 권한을 확인하세요.') if opened else '\n확인: 외부 TCP 연결 상태 조회가 다시 정상 동작합니다.'
    return ''


def patch(source):
    def once(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError('monitor_details_source_drift')
        source = source.replace(old, new, 1)
    if 'def connection_alert_detail(' in source:
        raise ValueError('monitor_details_already_applied')
    helpers = inspect.getsource(capture_connection_detail) + '\n\n' + inspect.getsource(connection_alert_detail)
    once('def advance_alerts(', helpers + '\n\ndef advance_alerts(')
    once('        is_bad=key in bad\n', "        if key in ('channel_state','egress_policy','egress_observation') and sample is not None:\n            a['connectionDetail']=capture_connection_detail(sample)\n        is_bad=key in bad\n")
    once("        if key=='egress_policy' and p['open'] and a.get('ports'):\n            content+='\\n확인된 TCP 포트: '+', '.join(str(x) for x in a['ports'])\n",
         "        content+=connection_alert_detail(key,p['open'],a.get('connectionDetail',{'ports':a.get('ports',[])}))\n")
    compile(source, 'monitor-details-candidate', 'exec')
    return source


if __name__ == '__main__':
    pathlib.Path(sys.argv[2]).write_text(patch(pathlib.Path(sys.argv[1]).read_text(encoding='utf8')), encoding='utf8')
