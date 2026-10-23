"""Build a guarded candidate from the installed monitor; never executes it."""
import pathlib
import sys

def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('monitor_source_drift')
    return source.replace(old, new, 1)

def patch(source):
    source=once(source,"now-stamp(observed)>540", "now-stamp(observed)>90")
    source=once(source,"now-stamp(health.get('at'))>540", "now-stamp(health.get('at'))>90")
    source=once(source,"'channel_state':'수집 채널 상태 이상'", "'channel_state':'수집 채널 상태 이상','egress_policy':'미허용 출발 포트 발견','egress_observation':'출발 통신 관측 실패'")
    source=once(source,"'flush_stalled','channel_state'}", "'flush_stalled','channel_state','egress_policy','egress_observation'}")
    source=once(source,"        if sample is not None:\n", """        # Retrying, missing or stale telemetry cannot confirm recovery.
        if key=='channel_state' and key not in bad and (sample is None or sample.get('channelRecoveryConfirmed') is not True or now-stamp(sample.get('healthAt'))>90):
            a['good']=0
            if a.get('pending') and not a['pending']['open']:
                a['pending']=None;a['open']=True
            continue
        if sample is not None:
""")
    source=once(source,"'channelErrors','lastEventAt','lastDeliveryAt')", "'channelErrors','channelRecoveryConfirmed','channelHealthReasons','observedEgressPorts','synSentPorts','unapprovedEgressPorts','egressTelemetryAvailable','lastEventAt','lastDeliveryAt')")
    # Only port numbers and aggregate reasons, never room/account/token payloads.
    old="        status,body,retry=sender(url+'?wait=true'"
    new="""        if key=='egress_policy' and p['open'] and a.get('ports'):
            content+='\\n확인된 TCP 포트: '+', '.join(str(x) for x in a['ports'])
        status,body,retry=sender(url+'?wait=true'"""
    source=once(source,old,new)
    source=once(source,"        is_bad=key in bad\n", "        if key=='egress_policy' and sample is not None:\n            a['ports']=[p for p in sample.get('unapprovedEgressPorts',[]) if type(p)==int and 1<=p<=65535][:32]\n        is_bad=key in bad\n")
    compile(source,'monitor-candidate','exec')
    return source

if __name__=='__main__':
    pathlib.Path(sys.argv[2]).write_text(patch(pathlib.Path(sys.argv[1]).read_text(encoding='utf8')),encoding='utf8')
