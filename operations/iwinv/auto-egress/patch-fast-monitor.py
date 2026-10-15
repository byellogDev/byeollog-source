"""Guarded upgrade of the installed auto-egress monitor; no provider mutations."""
import inspect
import pathlib
import sys


def auto_egress_observation(detail, now):
    # Missing/stale files are failures observed locally. Fresh source timestamps
    # are shared by both timers, so one controller sample cannot count twice.
    if not isinstance(detail, dict):
        return None
    at = detail.get('observedAt')
    if detail.get('error') == 'controller_stale':
        return 'stale:' + str(int(now // 30))
    return at if type(at) in (int, float) and -5 <= now-at <= 90 else None


def monitor_auto_egress_only(url, now):
    if not pathlib.Path('/etc/byeollog-egress/enabled').exists():
        return {'ok': True, 'disabled': True}
    try:
        value = read_json('/var/lib/byeollog-egress/status.json')
    except Exception:
        value = {}
    detail = capture_auto_egress(value, now)
    bad = {'auto_egress'} if detail['error'] or detail['needsReview'] else set()
    db = connect(ROOT/'metrics.sqlite3')
    try:
        state = get(db, 'alerts', {})
        topic = {'auto_egress': state['auto_egress']} if 'auto_egress' in state else {}
        advance_alerts(topic, bad, now, {'autoEgress': detail}, only={'auto_egress'})
        state.update(topic)
        put(db, 'alerts', state)
        # Separate bounded local history; never overwrite full monitor samples.
        db.execute('create table if not exists auto_egress_samples(at integer primary key,body text not null)')
        db.execute('insert or replace into auto_egress_samples values(?,?)', (now, json.dumps(detail)))
        db.execute('delete from auto_egress_samples where at<?', (now-2*86400,))
        db.execute('delete from auto_egress_samples where at not in (select at from auto_egress_samples order by at desc limit 6000)')
        db.commit()
        outcome = deliver(topic, url, now)
        state.update(topic)
        put(db, 'alerts', state)
        db.commit()
        result = {'ok': True, 'sampleAt': now, 'autoEgress': detail, 'notifications': outcome}
        atomic(ROOT/'auto-egress-status.json', result)
        return result
    finally:
        db.close()


def patch(source):
    if 'def monitor_auto_egress_only(' in source:
        raise ValueError('fast_monitor_already_applied')

    def once(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError('fast_monitor_source_drift')
        source = source.replace(old, new, 1)

    once("    return {'error': code, 'needsReview': value.get('needsReview') is True,",
         "    return {'observedAt': at if type(at) in (int, float) else None,\n            'error': code, 'needsReview': value.get('needsReview') is True,")
    once('def advance_alerts(state,bad,now,sample=None):',
         inspect.getsource(auto_egress_observation)+'\n\n'+inspect.getsource(monitor_auto_egress_only)+
         '\n\ndef advance_alerts(state,bad,now,sample=None,only=None):')
    once('    for key in LABELS:\n', '    for key in LABELS:\n        if only is not None and key not in only:continue\n')
    once("            observed=(sample.get('healthAt') if key in HEALTH_KEYS",
         "            observed=(auto_egress_observation(sample.get('autoEgress'),now) if key=='auto_egress' else sample.get('healthAt') if key in HEALTH_KEYS")
    once("        is_bad=key in bad\n", "        is_bad=key in bad\n        if key=='auto_egress' and is_bad and a.get('pending') and not a['pending']['open']:\n            a['pending']=None;a['open']=True\n")
    once('        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n',
         "        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n        except BlockingIOError:\n            print(json.dumps({'ok':True,'skipped':'monitor_busy'}));return\n")
    once("        if not re.fullmatch('[a-f0-9]{64}',cfg['token']):raise ValueError('invalid machine token')\n",
         "        if sys.argv[1:]==['--auto-egress-only']:\n            print(json.dumps(monitor_auto_egress_only(url,int(time.time()))));return\n        if sys.argv[1:]:raise ValueError('invalid monitor arguments')\n        if not re.fullmatch('[a-f0-9]{64}',cfg['token']):raise ValueError('invalid machine token')\n")
    compile(source, 'fast-auto-egress-monitor', 'exec')
    return source


if __name__ == '__main__':
    pathlib.Path(sys.argv[2]).write_text(patch(pathlib.Path(sys.argv[1]).read_text(encoding='utf8')), encoding='utf8')
