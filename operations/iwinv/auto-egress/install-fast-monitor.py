"""Install only the local alert timer; never restart the collector/controller."""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=35).stdout


def main():
    os.umask(0o077)
    expected = sys.argv[1]
    target = pathlib.Path('/usr/local/sbin/byeollog-ops-monitor')
    original = target.read_bytes()
    before = hashlib.sha256(original).hexdigest()
    if before != expected:
        raise ValueError('monitor_source_hash_changed')
    spec = importlib.util.spec_from_file_location('fast', pathlib.Path(__file__).with_name('patch-fast-monitor.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    candidate = module.patch(original.decode()).encode()
    units = ['byeollog-auto-egress-monitor.service', 'byeollog-auto-egress-monitor.timer']
    paths = [pathlib.Path('/etc/systemd/system')/name for name in units]
    if any(path.exists() for path in paths):
        raise ValueError('fast_monitor_units_already_exist')
    run('systemd-analyze', 'verify', *(str(pathlib.Path(__file__).with_name(name)) for name in units))
    root = pathlib.Path('/var/lib/byeollog-ops/monitor')
    backup = root/('monitor-before-fast-'+before+'.py')
    if not backup.exists():
        backup.write_bytes(original)
        backup.chmod(0o600)
    started = time.time()
    with (root/'monitor.lock').open('a') as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time()-started>30:raise TimeoutError('monitor_busy')
                time.sleep(0.25)
        if target.read_bytes()!=original:raise ValueError('monitor_changed_before_install')
        temp = target.with_suffix('.fast-candidate')
        temp.write_bytes(candidate);temp.chmod(0o755);temp.replace(target)
    try:
        for path,name in zip(paths,units):
            path.write_bytes(pathlib.Path(__file__).with_name(name).read_bytes());path.chmod(0o644)
        run('systemctl','daemon-reload')
        run('systemctl','enable','--now',units[1])
        run('systemctl','start',units[0])
        result=json.loads((root/'auto-egress-status.json').read_text())
        if result.get('ok') is not True or result.get('sampleAt',0)<int(started):
            raise ValueError('fast_monitor_readiness_failed')
        run('systemctl','is-active',units[1])
        print(json.dumps({'ok':True,'beforeSha256':before,'afterSha256':hashlib.sha256(target.read_bytes()).hexdigest(),
                          'sampleAt':result['sampleAt'],'notifications':result['notifications'],
                          'controllerError':result['autoEgress']['error']}))
    except Exception:
        subprocess.run(['systemctl','disable','--now',units[1]],capture_output=True,timeout=15)
        subprocess.run(['systemctl','stop',units[0]],capture_output=True,timeout=30)
        with (root/'monitor.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            temp=target.with_suffix('.fast-rollback');temp.write_bytes(original);temp.chmod(0o755);temp.replace(target)
        for path in paths:
            if path.exists():path.unlink()
        run('systemctl','daemon-reload')
        raise


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'ok':False,'errorType':type(error).__name__}));sys.exit(1)
