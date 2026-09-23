#!/usr/bin/env python3
"""Sanitize existing cloud snapshots and refresh matching encrypted mirrors.
Uses existing backup runner credentials and the existing recipient; no private key.
"""
import datetime,fcntl,hashlib,json,os,pathlib,re,sys,urllib.request
ROOT=pathlib.Path('/var/lib/byeollog-ops/independent-backups')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect refused')
def atomic(path,value):
    tmp=path.with_suffix('.retention.tmp');tmp.write_text(json.dumps(value)+'\n');tmp.chmod(0o600);tmp.replace(path)
def main():
    os.umask(0o077)
    with (ROOT/'runner.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        cfg=json.loads(pathlib.Path('/etc/byeollog-backup-runner.json').read_text())
        opener=urllib.request.build_opener(NoRedirect())
        def request(mode,body=None):
            req=urllib.request.Request('https://byeollog.com/api/backups?cron='+mode,data=json.dumps(body).encode() if body else None,headers={'Authorization':'Bearer '+cfg['secret'],'Content-Type':'application/json'})
            with opener.open(req,timeout=90) as response:
                raw=response.read(48*1024*1024+1)
                if len(raw)>48*1024*1024:raise RuntimeError('response too large')
                value=json.loads(raw)
                if not value.get('ok'):raise RuntimeError('retention request failed')
                return value
        mirrors={}
        for folder in ROOT.iterdir():
            if not folder.is_dir() or folder.is_symlink() or not re.fullmatch(r'[a-f0-9-]{36}',folder.name):continue
            for path in folder.glob('*.sealed.json'):
                if path.is_symlink() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.sealed\.json',path.name):continue
                data=json.loads(path.read_text());assert data['workspace_id']==folder.name
                mirrors[path]=data
        state_path=ROOT/'progress.json';state=json.loads(state_path.read_text())
        report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checked':0,'changed':0,'tilesRemoved':0,'sessionsRemoved':0,'mirrorsRefreshed':0,'failed':0}
        matched=set();items=request('retention-list')['items'];assert len(items)<=10000
        for item in items:
            try:
                result=request('retention-file',{'path':item['name']});report['checked']+=1
                report['changed']+=int(result['changed']);report['tilesRemoved']+=result['removedTiles'];report['sessionsRemoved']+=result['removedBroadcasts']
                if not result.get('archive'):continue
                for path,copy in mirrors.items():
                    if copy['workspace_id']!=result['workspace_id']:continue
                    source=copy.get('source_path')
                    if source!=result['path'] and (source or copy['created_at']!=result['created_at']):continue
                    updated={**copy,'source_path':result['path'],'archive':result['archive'],'wallpaperRetentionCutoff':result['cutoff']}
                    atomic(path,updated);assert json.loads(path.read_text())==updated
                    completed=state.get('completed',{}).get(copy['workspace_id'])
                    if completed and completed['file']==path.name:
                        completed['sha256']=hashlib.sha256(path.read_bytes()).hexdigest();atomic(state_path,state)
                    matched.add(path);report['mirrorsRefreshed']+=1
            except Exception as error:
                report['failed']+=1
                print(json.dumps({'errorType':type(error).__name__,'itemNumber':report['checked']+report['failed']}),flush=True)
        report['unmatchedMirrors']=len(set(mirrors)-matched)
        report['ok']=not report['failed'] and not report['unmatchedMirrors']
        atomic(ROOT.parent/'wallpaper-retention-status.json',report);print(json.dumps(report))
        return 0 if report['ok'] else 1
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'ok':False,'type':type(error).__name__}));sys.exit(1)
