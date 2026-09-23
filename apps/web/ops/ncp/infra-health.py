#!/usr/bin/env python3
"""Local-only operational checks. Never restart a collector or log event bodies."""
import datetime,json,os,pathlib,subprocess,sys,syslog,time

def evaluate(s):
    warnings=[];critical=[]
    for value,warn,crit,name,inverse in [(s['diskPercent'],75,85,'disk',False),(s['memoryAvailablePercent'],20,10,'memory',True),(s['pidPercent'],80,95,'pids',False),(s['pending'],100,5000,'queue',False),(s['oldestAgeSeconds'],120,600,'delivery_age',False),(s['memoryPending'],100,1000,'memory_queue',False)]:
        if (value<=crit if inverse else value>=crit):critical.append(name)
        elif (value<=warn if inverse else value>=warn):warnings.append(name)
    if s['container']!='running:healthy':critical.append('container')
    if s.get('workerAgeSeconds',0)>60:critical.append('worker_heartbeat')
    if s['deadLetters'] or s['corrupt']:warnings.append('quarantined_events')
    if s.get('memoryOldestAgeSeconds',0)>=60:warnings.append('memory_queue_age')
    if s.get('pending',0) and s.get('flushAgeSeconds',0)>60:warnings.append('flush_stalled')
    if s.get('channelErrors',0):warnings.append('channel_state')
    return {'level':'critical' if critical else 'warning' if warnings else 'info','critical':critical,'warnings':warnings}

def command(args):return subprocess.check_output(args,timeout=15,text=True)
def main():
    name='soop-chat-gateway-soop-gateway-1';now=time.time()
    d=json.loads(command(['docker','inspect',name]))[0]
    pids=int(json.loads(command(['docker','stats','--no-stream','--format','{{json .}}',name]))['PIDs'])
    volume=next(x['Source'] for x in d['Mounts'] if x['Destination']=='/var/lib/byeollog')
    pending=list(pathlib.Path(volume,'outbox').glob('*.json'));dead=[p for p in pending if '.dead-' in p.name];pending=[p for p in pending if '.dead-' not in p.name]
    oldest=0
    for p in pending:
        try:created=json.loads(p.read_text()).get('createdAt');age=now-datetime.datetime.fromisoformat(created.replace('Z','+00:00')).timestamp();oldest=max(oldest,age)
        except FileNotFoundError:pass
        except Exception:oldest=max(oldest,now-p.stat().st_mtime)
    mem={line.split(':')[0]:int(line.split()[1]) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
    disk=os.statvfs('/');worker=json.loads(pathlib.Path(volume,'worker-state.json').read_text());channels=worker.get('channels',[])
    def age(key):
        value=worker.get(key)
        return max(0,now-datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()) if value else 0
    s={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'diskPercent':round(100*(1-disk.f_bavail/disk.f_blocks)),
       'memoryAvailablePercent':round(100*mem['MemAvailable']/mem['MemTotal']),'pids':pids,'pidLimit':d['HostConfig']['PidsLimit'],
       'pidPercent':round(100*pids/max(1,d['HostConfig']['PidsLimit'])),'container':d['State']['Status']+':'+d['State'].get('Health',{}).get('Status','missing'),
       'pending':len(pending),'deadLetters':len(dead),'corrupt':len(list(pathlib.Path(volume,'outbox').glob('*.corrupt-*'))),'oldestAgeSeconds':round(oldest),
       'memoryPending':sum(x.get('memoryPending',0) for x in channels),'memoryOldestAgeSeconds':max([0]+[x.get('memoryOldestAgeMs',0)/1000 for x in channels]),
       'workerAgeSeconds':round(age('heartbeatAt')),'flushAgeSeconds':round(age('lastFlushFinishedAt')),
       'channelCount':len(channels),'channelErrors':sum(x.get('state') not in ('waiting_for_live','connected','connecting','idle') for x in channels),
       'channelTelemetryAvailable':'channels' in worker,
       'lastDeliveryAt':worker.get('lastDeliveryAt'),
       'lastEventAt':max((x.get('lastEventAt') for x in channels if isinstance(x.get('lastEventAt'),str)),default=None)}
    s.update(evaluate(s));encoded=json.dumps(s,sort_keys=True)
    dest=pathlib.Path('/var/lib/byeollog-ops');dest.mkdir(mode=0o700,exist_ok=True)
    temp=dest/'health.json.tmp';temp.write_text(encoded+'\n');temp.chmod(0o600);temp.replace(dest/'health.json')
    syslog.openlog('byeollog-health');syslog.syslog(syslog.LOG_ERR if s['level']=='critical' else syslog.LOG_WARNING if s['level']=='warning' else syslog.LOG_INFO,encoded)
    print(encoded);return 1 if s['level']=='critical' else 0
if __name__=='__main__':sys.exit(main())
