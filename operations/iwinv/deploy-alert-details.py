#!/usr/bin/env python3
"""Deploy only reviewed Discord formatting; preserve collector and firewall."""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time

HERE=pathlib.Path(__file__).resolve().parent
TARGET=pathlib.Path('/usr/local/sbin/byeollog-ops-monitor')
EXPECTED='f6c949bb1895191cf896f04e1d257ff083fcdc59fabdf1b99b2af28235a97dfa'

def run(args):return subprocess.check_output(args,text=True,timeout=55)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path,value):path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o600)
def collector():
    d=json.loads(run(['docker','inspect','soop-chat-gateway-soop-gateway-1']))[0]
    return [d['Id'],d['Image'],d['State']['StartedAt'],d['RestartCount']]
def replace(data):
    p=TARGET.with_name(TARGET.name+'.details-tmp')
    with p.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    p.chmod(0o755);p.replace(TARGET)
def wait_idle():
    deadline=time.monotonic()+50
    while time.monotonic()<deadline:
        if run(['systemctl','show','byeollog-ops-monitor.service','--property=ActiveState','--value']).strip() not in ('active','activating','deactivating'):return
        time.sleep(1)
    raise RuntimeError('monitor_busy')

def prepare():
    if digest(TARGET)!=EXPECTED or TARGET.is_symlink():raise RuntimeError('monitor_drift')
    backup=HERE/'monitor-before.py'
    with backup.open('xb') as f:f.write(TARGET.read_bytes())
    spec=importlib.util.spec_from_file_location('patcher',HERE/'patch-alert-details.py')
    patcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(patcher)
    candidate=HERE/'monitor-candidate.py';candidate.write_text(patcher.patch(TARGET.read_text()))
    subprocess.run([sys.executable,'-B',str(HERE/'alert-details.test.py'),str(backup)],check=True,timeout=20)
    receipt={'before':EXPECTED,'after':digest(candidate),'collector':collector(),'mode':TARGET.stat().st_mode & 0o777}
    save(HERE/'prepared.json',receipt);print(json.dumps({'prepared':True,'before':EXPECTED,'after':receipt['after']}))

def install(rollback=False):
    receipt=json.loads((HERE/'prepared.json').read_text())
    required=receipt['after'] if rollback else receipt['before']
    if digest(TARGET)!=required or TARGET.is_symlink():raise RuntimeError('monitor_drift')
    source=HERE/('monitor-before.py' if rollback else 'monitor-candidate.py')
    expected=receipt['before'] if rollback else receipt['after']
    if digest(source)!=expected:raise RuntimeError('source_drift')
    if digest(HERE/'monitor-before.py')!=receipt['before']:raise RuntimeError('backup_drift')
    original_collector=collector();changed=False
    try:
        run(['systemctl','stop','byeollog-ops-monitor.timer']);wait_idle()
        if digest(TARGET)!=required:raise RuntimeError('monitor_drift')
        replace(source.read_bytes());TARGET.chmod(receipt['mode']);changed=True
        run(['systemctl','start','byeollog-ops-monitor.service'])
        if digest(TARGET)!=expected or collector()!=original_collector:raise RuntimeError('postdeploy_mismatch')
        status=json.loads(pathlib.Path('/var/lib/byeollog-ops/monitor/status.json').read_text())
        outcome={'installed':not rollback,'rolledBack':rollback,'at':status['at'],'hash':expected,
                 'bad':status['bad'],'notifications':status['notifications'],'collectorUnchanged':True}
        save(HERE/('rollback.json' if rollback else 'installed.json'),outcome);print(json.dumps(outcome))
    except Exception:
        if changed and not rollback and digest(TARGET)==receipt['after']:
            replace((HERE/'monitor-before.py').read_bytes());TARGET.chmod(receipt['mode'])
        raise
    finally:run(['systemctl','start','byeollog-ops-monitor.timer'])

if __name__=='__main__':
    os.umask(0o077)
    if sys.argv[1:]==['prepare']:prepare()
    elif sys.argv[1:]==['install']:install()
    elif sys.argv[1:]==['rollback']:install(True)
    else:raise SystemExit('usage: deploy-alert-details.py prepare|install|rollback')
