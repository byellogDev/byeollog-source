#!/bin/sh
set -eu
sudo -n python3 - <<'PY'
import json,subprocess,os,pathlib,datetime
name='soop-chat-gateway-soop-gateway-1'
d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
logs=subprocess.check_output(['docker','logs','--tail','3000',name],stderr=subprocess.STDOUT).decode(errors='replace')
states={}; errors={}
for line in logs.splitlines():
 try: e=json.loads(line)
 except: continue
 w=e.get('workspace'); event=e.get('event','')
 if w and event in ('sdk_state','broadcast_offline','workspace_stopped','session_failed','sdk_ready'): states[w]={'event':event,'state':e.get('state'),'at':e.get('at')}
 if e.get('level') in ('error','fatal'):errors[event]=errors.get(event,0)+1
mount=next(m['Source'] for m in d['Mounts'] if m['Destination']=='/var/lib/byeollog')
p=list(pathlib.Path(mount,'outbox').glob('*.json'))
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'container':{'image':d['Image'],'status':d['State']['Status'],'health':d['State'].get('Health',{}).get('Status'),'restartCount':d['RestartCount'],'pidsLimit':d['HostConfig']['PidsLimit'],'logConfig':d['HostConfig']['LogConfig'],'logBytes':os.path.getsize(d['LogPath'])},'outbox':{'pending':sum('.dead-' not in x.name for x in p),'dead':sum('.dead-' in x.name for x in p)},'recentChannelStates':list(states.values()),'recentErrorCounts':errors,'healthTimer':subprocess.run(['systemctl','is-active','byeollog-health.timer'],capture_output=True,text=True).stdout.strip(),'automaticSecurityUpdates':subprocess.run(['systemctl','is-enabled','apt-daily-upgrade.timer'],capture_output=True,text=True).stdout.strip()}))
PY
