#!/usr/bin/env python3
"""Guarded monitor-only deployment. Run from the uploaded canonical source bundle."""
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import runpy
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
HEALTH = pathlib.Path('/usr/local/sbin/byeollog-infra-health')
MONITOR = pathlib.Path('/usr/local/sbin/byeollog-ops-monitor')
LIB = pathlib.Path('/usr/local/lib/byeollog-monitor')
DROPIN = pathlib.Path('/etc/systemd/system/byeollog-health.timer.d/30s.conf')
TIMERS = ['byeollog-health.timer', 'byeollog-ops-monitor.timer']
SERVICES = ['byeollog-health.service', 'byeollog-ops-monitor.service']
EXPECTED = {
    str(HEALTH): '4a69664717c2f936f75417778b4edb6194687f533d57bb1342e149634aa62e06',
    str(MONITOR): '0350e31909dd30e2ef28e0efb3ade77d38f301a526928372b79e55a5de3b8c34',
}

def run(args):
    return subprocess.check_output(args, text=True, timeout=55)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n'); path.chmod(0o600)

def atomic(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp=path.with_name(path.name+'.deploy-tmp')
    with temp.open('xb') as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
    temp.chmod(mode); temp.replace(path)

def container():
    d=json.loads(run(['docker','inspect','soop-chat-gateway-soop-gateway-1']))[0]
    return {'id':d['Id'],'image':d['Image'],'startedAt':d['State']['StartedAt'],'restartCount':d['RestartCount']}

def check_baseline():
    if any(digest(pathlib.Path(p)) != sha for p,sha in EXPECTED.items()):
        raise RuntimeError('installed_monitor_drift')

def prepare():
    check_baseline()
    backup=HERE/'backup'; backup.mkdir(mode=0o700)
    sources=[(HEALTH,HERE/'infra-health.py'),(MONITOR,HERE/'monitor-candidate.py'),
             (LIB/'channel_health.py',HERE/'channel_health.py'),
             (LIB/'egress-policy.json',HERE/'egress-policy.json'),(DROPIN,HERE/'health-frequency.conf')]
    spec=importlib.util.spec_from_file_location('patcher',HERE/'patch-ops-monitor.py')
    patcher=importlib.util.module_from_spec(spec); spec.loader.exec_module(patcher)
    (HERE/'monitor-candidate.py').write_text(patcher.patch(MONITOR.read_text()))
    entries=[]
    for index,(destination,source) in enumerate(sources):
        if destination.is_symlink():raise RuntimeError('unexpected_symlink')
        exists=destination.exists(); b=backup/str(index)
        if exists:shutil.copy2(destination,b)
        entries.append({'destination':str(destination),'source':source.name,'backup':str(b),
                        'existed':exists,'before':digest(b) if exists else None,
                        'mode':destination.stat().st_mode & 0o777 if exists else None,
                        'after':digest(source),'newMode':0o755 if destination in (HEALTH,MONITOR) else 0o644})
    for name in ('infra-health.py','channel_health.py','monitor-candidate.py'):
        compile((HERE/name).read_text(),name,'exec')
    for name,args in [('channel-health.test.py',[]),('monitor-recovery.test.py',[str(MONITOR)])]:
        subprocess.run([sys.executable,'-B',str(HERE/name),*args],check=True,timeout=20)
    # Real host inputs, isolated output directory; no alert sender or production state writes.
    isolated=HERE/'candidate-state'; isolated.mkdir(mode=0o700)
    module=runpy.run_path(str(HERE/'infra-health.py'),run_name='candidate')
    module['main'].__globals__.update(ROOT=isolated,POLICY=HERE/'egress-policy.json')
    module['main']()
    report=json.loads((isolated/'health.json').read_text())
    if report['channelErrors'] or not report['channelRecoveryConfirmed'] or report['unapprovedEgressPorts'] or not report['egressTelemetryAvailable']:
        raise RuntimeError('candidate_requires_review')
    receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entries':entries,
             'container':container(),'candidateHealth':report,'prepared':True}
    save(HERE/'prepared.json',receipt)
    print(json.dumps({'prepared':True,'candidateHealth':report,'containerUnchanged':True}))

def stop_timers():
    run(['systemctl','stop',*TIMERS])
    deadline=time.monotonic()+50
    while time.monotonic()<deadline:
        states=[run(['systemctl','show',s,'--property=ActiveState','--value']).strip() for s in SERVICES]
        if all(s not in ('active','activating','deactivating') for s in states):return
        time.sleep(1)
    raise RuntimeError('monitor_service_busy')

def restore(receipt):
    for e in receipt['entries']:
        target=pathlib.Path(e['destination'])
        if target.is_symlink() or (target.exists() and digest(target) not in (e['before'],e['after'])):
            raise RuntimeError('rollback_target_drift')
    for e in reversed(receipt['entries']):
        target=pathlib.Path(e['destination'])
        if e['existed']:
            backup=pathlib.Path(e['backup'])
            if digest(backup)!=e['before']:raise RuntimeError('backup_drift')
            atomic(target,backup.read_bytes(),e['mode'])
        elif target.exists():
            if digest(target)!=e['after']:raise RuntimeError('rollback_target_drift')
            target.unlink()
    run(['systemctl','daemon-reload'])

def install():
    receipt=json.loads((HERE/'prepared.json').read_text())
    check_baseline()
    for e in receipt['entries']:
        target=pathlib.Path(e['destination'])
        if digest(HERE/e['source'])!=e['after'] or target.exists()!=e['existed'] or (e['existed'] and digest(target)!=e['before']):
            raise RuntimeError('candidate_or_target_drift')
    if container()!=receipt['container']:raise RuntimeError('collector_changed_since_prepare')
    changed=False
    try:
        stop_timers(); check_baseline()
        changed=True
        for e in receipt['entries']:atomic(pathlib.Path(e['destination']),(HERE/e['source']).read_bytes(),e['newMode'])
        run(['systemctl','daemon-reload'])
        run(['systemctl','start','byeollog-health.service'])
        health=json.loads(pathlib.Path('/var/lib/byeollog-ops/health.json').read_text())
        if 'channelRecoveryConfirmed' not in health or 'egressTelemetryAvailable' not in health:raise RuntimeError('health_contract_missing')
        if container()!=receipt['container']:raise RuntimeError('collector_changed_during_install')
        for e in receipt['entries']:
            if digest(pathlib.Path(e['destination']))!=e['after']:raise RuntimeError('installed_hash_mismatch')
        run(['systemctl','start',*TIMERS])
        receipt.update(installed=True,installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),health=health,
                       timer=run(['systemctl','show','byeollog-health.timer','--property=TimersMonotonic','--property=RandomizedDelayUSec','--property=AccuracyUSec']))
        save(HERE/'installed.json',receipt)
        print(json.dumps({'installed':True,'at':receipt['installedAt'],'health':health,'timer':receipt['timer'],'collectorUnchanged':True}))
    except Exception:
        if changed:restore(receipt)
        run(['systemctl','start',*TIMERS])
        raise

if __name__=='__main__':
    os.umask(0o077)
    if sys.argv[1:] == ['prepare']:prepare()
    elif sys.argv[1:] == ['install']:install()
    elif sys.argv[1:] == ['rollback']:
        receipt=json.loads((HERE/'prepared.json').read_text());stop_timers()
        try:restore(receipt)
        finally:run(['systemctl','start',*TIMERS])
    else:raise SystemExit('usage: deploy-health.py prepare|install|rollback')
