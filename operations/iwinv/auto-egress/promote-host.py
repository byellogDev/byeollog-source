#!/usr/bin/env python3
"""Promote the tested image, preserving compose limits, env secrets and state.

On failed readiness restore the original compose/env and previous image.
This command never changes provider rules or removes user data.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import time


def inspect():
    return json.loads(subprocess.check_output(['docker','inspect','soop-chat-gateway-soop-gateway-1'],text=True))[0]


def collector_ready(container, worker, workspaces, started_after):
    try:
        heartbeat=datetime.datetime.fromisoformat(worker['heartbeatAt'].replace('Z','+00:00')).timestamp()
        channels=worker['channels']
        return (container['State'].get('Health',{}).get('Status')=='healthy' and heartbeat>=started_after
                and sorted(c['workspace'] for c in channels)==sorted(workspaces)
                and all(c['state']=='connected' or (c['state']=='waiting_for_live' and c.get('lastErrorCode')=='broadcast_offline') for c in channels))
    except (KeyError,TypeError,ValueError):return False


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--image',required=True)
    parser.add_argument('--previous-image',required=True)
    parser.add_argument('--evidence',required=True)
    args=parser.parse_args()
    assert os.getuid()==0
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',args.image)
    os.umask(0o077)
    evidence=pathlib.Path(args.evidence).resolve(strict=True)
    assert evidence.is_relative_to('/root')
    before=inspect()
    assert before['Image']==args.previous_image and before['State']['Health']['Status']=='healthy'
    compose=pathlib.Path(before['Config']['Labels']['com.docker.compose.project.config_files'])
    assert str(compose)=='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'
    env=compose.with_name('.env.gateway')
    volume=pathlib.Path(next(m['Source'] for m in before['Mounts'] if m['Destination']=='/var/lib/byeollog'))
    worker=json.loads((volume/'worker-state.json').read_text())
    assert len(worker['channels'])==5
    assert all(c['state']=='waiting_for_live' and c.get('lastErrorCode')=='broadcast_offline' for c in worker['channels']), 'broadcast_started_reassess'
    auto=json.loads(pathlib.Path('/var/lib/byeollog-egress/status.json').read_text())
    assert auto['lastError'] is None and not auto['needsReview'] and time.time()-auto['at']<90
    assert subprocess.check_output(['systemctl','is-active','byeollog-auto-egress.service'],text=True).strip()=='active'
    backup=evidence/('promotion-backup-'+str(time.time_ns()))
    backup.mkdir(mode=0o700,exist_ok=False)
    shutil.copy2(compose,backup/'compose.yml')
    shutil.copy2(env,backup/'gateway.env')
    old=compose.read_text()
    changed,n=re.subn(r'(?m)^    image: .+$','    image: '+args.image,old)
    assert n==1
    env_text=env.read_text()
    assert not re.search(r'(?m)^SOOP_EGRESS_',env_text), 'existing_egress_settings'
    command=['docker','compose','-f',str(compose),'up','-d','--no-build','--no-deps','soop-gateway']
    host_keys=('ReadonlyRootfs','CapDrop','PidsLimit','Memory','MemoryReservation','Tmpfs','SecurityOpt','PortBindings','LogConfig','Init','RestartPolicy')
    start=time.time()
    try:
        compose.write_text(changed)
        env.write_text(env_text.rstrip()+'\nSOOP_EGRESS_CONTROL_SOCKET=/var/lib/byeollog/egress-control/control.sock\nSOOP_EGRESS_BASELINE_PORTS=8041,9001\n')
        env.chmod(0o600)
        subprocess.run(command,check=True,cwd=compose.parent,timeout=150,capture_output=True)
        deadline=time.time()+90
        while time.time()<deadline:
            after=inspect()
            try:current_worker=json.loads((volume/'worker-state.json').read_text())
            except (OSError,ValueError):current_worker={}
            if collector_ready(after,current_worker,[c['workspace'] for c in worker['channels']],start):break
            time.sleep(2)
        assert collector_ready(after,current_worker,[c['workspace'] for c in worker['channels']],start),'channel_readiness_failed'
        assert after['Image']==args.image and after['State'].get('Health',{}).get('Status')=='healthy'
        assert all(after['HostConfig'].get(k)==before['HostConfig'].get(k) for k in host_keys),'container_security_drift'
        assert after['Mounts']==before['Mounts'],'mount_drift'
        expected=dict(e.split('=',1) for e in before['Config']['Env'])
        actual=dict(e.split('=',1) for e in after['Config']['Env'])
        expected.update(SOOP_EGRESS_CONTROL_SOCKET='/var/lib/byeollog/egress-control/control.sock',SOOP_EGRESS_BASELINE_PORTS='8041,9001')
        assert actual==expected,'container_environment_drift'
        worker=current_worker
        policy_path=pathlib.Path('/usr/local/lib/byeollog-monitor/egress-policy.json')
        policy=json.loads(policy_path.read_text());policy['autoChangeFirewall']=True
        policy_path.write_text(json.dumps(policy,sort_keys=True))
        pathlib.Path('/etc/byeollog-egress/enabled').write_text('verified-provider-api\n')
        subprocess.run(['/usr/local/sbin/byeollog-infra-health'],check=True,capture_output=True,timeout=30)
    except Exception as error:
        (backup/'failure.json').write_text(json.dumps({'at':time.time(),'errorType':type(error).__name__,
          'channels':[{'state':c.get('state'),'error':c.get('lastErrorCode')} for c in locals().get('current_worker',{}).get('channels',[])]}))
        shutil.copy2(backup/'compose.yml',compose);shutil.copy2(backup/'gateway.env',env)
        pathlib.Path('/etc/byeollog-egress/enabled').unlink(missing_ok=True)
        shutil.copy2(evidence/'install-backup'/'egress-policy.json','/usr/local/lib/byeollog-monitor/egress-policy.json')
        subprocess.run(command,check=True,cwd=compose.parent,timeout=150,capture_output=True)
        raise
    result={'promoted':True,'image':args.image,'previousImage':args.previous_image,'elapsedSeconds':round(time.time()-start,2),
            'startedAt':after['State']['StartedAt'],'channelStates':[c['state'] for c in worker['channels']],
            'composeSha256':hashlib.sha256(compose.read_bytes()).hexdigest(),'securitySettingsPreserved':True,'backup':str(backup)}
    (evidence/'promotion-receipt.json').write_text(json.dumps(result,sort_keys=True))
    print(json.dumps(result))


if __name__=='__main__':main()
