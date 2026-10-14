#!/usr/bin/env python3
"""Install a verified controller candidate; does not replace the collector.

The private evidence directory must contain live API readbacks and a completed
redundant-rule create/read/delete receipt. Credentials remain root-only.
"""
import argparse
import hashlib
import grp
import importlib.util
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--expected-image', required=True)
    args = parser.parse_args()
    assert os.getuid() == 0
    os.umask(0o077)
    source = pathlib.Path(__file__).resolve().parent
    evidence = pathlib.Path(args.evidence).resolve(strict=True)
    assert evidence.is_relative_to('/root') and not evidence.is_symlink()
    receipt = json.loads((evidence/'provider-test-uppercase.json').read_text())
    assert receipt['phase'] == 'created_verified_deleted'
    group = receipt['group']
    credential_path = pathlib.Path('/etc/byeollog-egress/iwinv.json')
    assert credential_path.stat().st_uid == 0 and credential_path.stat().st_mode & 0o077 == 0
    credential = json.loads(credential_path.read_text())
    from iwinv_api import FirewallApi
    from policy import rule
    api = FirewallApi(credential['access'], credential['secret'], group)
    baseline = json.loads((evidence/'rules-response.json').read_text())['result']
    assert sorted(map(rule, api.rules())) == sorted(map(rule, baseline)), 'baseline_drift'
    association = json.loads((evidence/'instances-response.json').read_text())
    current = api.request('GET', '/instances')
    ids = [r['instance_id'] for r in association['result']]
    assert len(ids) == 1 and current['count'] == 1 and [r['instance_id'] for r in current['result']] == ids
    container = json.loads(run('docker', 'inspect', 'soop-chat-gateway-soop-gateway-1'))[0]
    assert container['Image'] == args.expected_image and container['State']['Running']
    assert run('docker', 'exec', container['Id'], 'id', '-u') == '10001'
    assert run('docker', 'exec', container['Id'], 'id', '-g') == '10001'
    volume = pathlib.Path(next(m['Source'] for m in container['Mounts'] if m['Destination'] == '/var/lib/byeollog')).resolve(strict=True)
    assert volume.is_relative_to('/var/lib/docker/volumes')
    assert not pathlib.Path('/etc/byeollog-egress/enabled').exists(), 'already_enabled'
    monitor = pathlib.Path('/usr/local/sbin/byeollog-ops-monitor')
    assert hashlib.sha256(monitor.read_bytes()).hexdigest() == 'd938b59b11ef4de4df6e0ea4438179de6fa9630412973d44565fbae7fc6b46f8', 'monitor_drift'
    subprocess.run([sys.executable, '-B', str(source/'monitor.test.py'), str(monitor)], check=True)
    backup = evidence/'install-backup'
    backup.mkdir(mode=0o700, exist_ok=False)
    targets = [monitor, pathlib.Path('/usr/local/sbin/byeollog-infra-health'),
               pathlib.Path('/usr/local/lib/byeollog-monitor/channel_health.py'),
               pathlib.Path('/usr/local/lib/byeollog-monitor/egress-policy.json')]
    for path in targets:
        shutil.copy2(path, backup/path.name)
    (backup/'container.json').write_text(json.dumps(container))
    # Container group IDs need a host group record for systemd Group=.
    try:
        grp.getgrgid(10001)
    except KeyError:
        subprocess.run(['groupadd', '--gid', '10001', 'byeollog-collector-socket'], check=True)
    try:
        user = pwd.getpwnam('byeollog-egress')
    except KeyError:
        subprocess.run(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'byeollog-egress'], check=True)
        user = pwd.getpwnam('byeollog-egress')
    lib = pathlib.Path('/usr/local/lib/byeollog-egress')
    lib.mkdir(mode=0o755, exist_ok=True)
    lib.chmod(0o755)
    names = ('controller.py', 'iwinv_api.py', 'policy.py', 'observe.py')
    for name in names:
        shutil.copyfile(source/name, lib/name)
        (lib/name).chmod(0o644)
    state = pathlib.Path('/var/lib/byeollog-egress')
    state.mkdir(mode=0o700, exist_ok=True)
    os.chown(state, user.pw_uid, 10001)
    socket_dir = volume/'egress-control'
    assert not socket_dir.is_symlink()
    socket_dir.mkdir(mode=0o750, exist_ok=True)
    os.chown(socket_dir, user.pw_uid, 10001)
    socket_dir.chmod(0o750)
    config_dir = credential_path.parent
    config_dir.chmod(0o755)
    config = {'group': group, 'baseline': baseline, 'association': {'idField':'instance_id', 'ids':ids},
              'collectorUid':10001, 'state':str(state/'state.json'), 'status':str(state/'status.json'),
              'observation':'/var/lib/byeollog-egress-observer/connections.json',
              'socket':'/run/byeollog-egress/control.sock'}
    (config_dir/'config.json').write_text(json.dumps(config, sort_keys=True))
    (config_dir/'config.json').chmod(0o644)
    unit = (source/'byeollog-auto-egress.service.example').read_text()
    old = '# BindPaths=/actual/volume/_data/egress-control:/run/byeollog-egress'
    assert unit.count(old) == 1
    unit = unit.replace(old, 'BindPaths='+str(socket_dir)+':/run/byeollog-egress')
    unit_dir = pathlib.Path('/etc/systemd/system')
    (unit_dir/'byeollog-auto-egress.service').write_text(unit)
    for name in ('byeollog-egress-observe.service', 'byeollog-egress-observe.timer'):
        shutil.copyfile(source/name, unit_dir/name)
    for name in ('byeollog-auto-egress.service','byeollog-egress-observe.service','byeollog-egress-observe.timer'):
        (unit_dir/name).chmod(0o644)
    subprocess.run(['systemd-analyze', 'verify', str(unit_dir/'byeollog-auto-egress.service'), str(unit_dir/'byeollog-egress-observe.service'), str(unit_dir/'byeollog-egress-observe.timer')], check=True)
    spec = importlib.util.spec_from_file_location('monitor_patch', source/'patch-monitor.py')
    patch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patch)
    monitor.write_text(patch.patch(monitor.read_text()))
    shutil.copyfile(source.parent/'infra-health.py', targets[1])
    shutil.copyfile(source.parent/'channel_health.py', targets[2])
    for path in targets[:3]:
        compile(path.read_text(), str(path), 'exec')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'byeollog-egress-observe.timer'], check=True)
    subprocess.run(['systemctl', 'start', 'byeollog-egress-observe.service'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'byeollog-auto-egress.service'], check=True)
    result = {'installed':True, 'collectorReplaced':False, 'monitorEnabled':False,
              'controllerHashes':{name:hashlib.sha256((lib/name).read_bytes()).hexdigest() for name in names}}
    (evidence/'install-receipt.json').write_text(json.dumps(result,sort_keys=True))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
