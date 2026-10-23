"""Bounded local metadata only. No HTTP bodies, secrets, identifiers or probes."""
import json
import logging
import logging.handlers
import os
import threading
import time
from pathlib import Path


class PrivateRotatingHandler(logging.handlers.RotatingFileHandler):
    def emit(self,record):
        self.failed=False
        super().emit(record)

    def _open(self):
        fd=os.open(self.baseFilename,os.O_CREAT|os.O_APPEND|os.O_WRONLY|getattr(os,'O_NOFOLLOW',0),0o600)
        if hasattr(os,'fchmod'):os.fchmod(fd,0o600)
        return os.fdopen(fd,'a',encoding='utf8')

    def handleError(self, record):
        # Logging failure must not change provider outcomes or emit record data.
        self.failed=True


def host_context(proc=Path('/proc'), disk=Path('/var/lib/byeollog-egress')):
    result={}
    try:
        values={}
        for line in (proc/'meminfo').read_text()[:8192].splitlines():
            parts=line.split()
            if len(parts)>=2 and parts[0] in ('MemAvailable:','MemTotal:') and parts[1].isdigit():
                values[parts[0][:-1]]=int(parts[1])*1024
        result['memoryBytes']=values
    except OSError:result['memoryUnavailable']=True
    try:
        usage=os.statvfs(disk)
        result['diskFreeBytes']=usage.f_bavail*usage.f_frsize
    except (OSError,AttributeError):result['diskUnavailable']=True
    try:result['loadAverage']=[round(x,3) for x in os.getloadavg()]
    except (OSError,AttributeError):pass
    try:
        # Totals only: never store interface names, IPs, hostnames or peers.
        counters={'rxErrors':0,'rxDrops':0,'txErrors':0,'txDrops':0}
        for line in (proc/'net/dev').read_text()[:16384].splitlines():
            if ':' not in line:continue
            values=line.split(':',1)[1].split()
            if len(values)<16 or not all(v.isdigit() for v in values[:16]):continue
            for name,index in [('rxErrors',2),('rxDrops',3),('txErrors',10),('txDrops',11)]:
                counters[name]+=int(values[index])
        result['networkCounters']=counters
    except OSError:result['networkUnavailable']=True
    try:result['processFdCount']=sum(1 for _ in (proc/'self/fd').iterdir())
    except OSError:pass
    return result


class Diagnostics:
    def __init__(self,path,*,max_bytes=4*1024*1024,backups=15,clock=time.time,context=host_context):
        self.clock,self.context=clock,context
        self.lock=threading.Lock();self.last_snapshot=-float('inf')
        self.handler=PrivateRotatingHandler(path,maxBytes=max_bytes,backupCount=backups,encoding='utf8')
        self.handler.failed=False
        self.handler.setFormatter(logging.Formatter('%(message)s'))

    def write(self,value):
        # Callers construct fixed schemas; reject oversized diagnostic events.
        raw=json.dumps(value,separators=(',',':'),allow_nan=False)
        if len(raw.encode('utf8'))>8192:
            self.handler.failed=True
            return
        self.handler.handle(logging.LogRecord('egress_diagnostics',logging.INFO,'',0,raw,(),None))

    def api(self,record):
        self.write(record)
        if record.get('outcome')=='ok':return
        with self.lock:
            now=self.clock()
            if now-self.last_snapshot<60:return
            self.last_snapshot=now
        try:context=self.context()
        except Exception:context={'unavailable':True}
        self.write({'event':'failure_context','at':now,'requestId':record['requestId'],'host':context})

    def cycle(self,phase,error,elapsed_ms,api_record):
        # Error codes are internal, but still constrain the serialized value.
        safe=error if isinstance(error,str) and len(error)<=80 and all(c in 'abcdefghijklmnopqrstuvwxyz_0123456789' for c in error) else None
        self.write({'event':'maintenance','at':self.clock(),'phase':phase,
                    'error':safe,'elapsedMs':elapsed_ms,
                    'lastRequestId':api_record.get('requestId') if api_record else None})

    def close(self):self.handler.close()
