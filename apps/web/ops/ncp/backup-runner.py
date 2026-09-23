#!/usr/bin/env python3
"""One workspace per HTTP request; encrypted off-project copies; resumable state."""
import datetime,fcntl,hashlib,json,os,pathlib,re,shutil,sys,time,urllib.request,urllib.error
ROOT=pathlib.Path('/var/lib/byeollog-ops/independent-backups')
CONFIG=pathlib.Path('/etc/byeollog-backup-runner.json')
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect refused')
def atomic(path,value):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value)+'\n');tmp.chmod(0o600);tmp.replace(path)
def main():
    os.umask(0o077);ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (ROOT/'runner.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return run_locked()
def run_locked():
    cfg=json.loads(CONFIG.read_text());assert len(cfg['secret'])>=16
    opener=urllib.request.build_opener(NoRedirect())
    def request(mode,body=None):
        req=urllib.request.Request('https://byeollog.com/api/backups?cron='+mode,data=json.dumps(body).encode() if body else None,headers={'Authorization':'Bearer '+cfg['secret'],'Content-Type':'application/json','User-Agent':'byeollog-independent-backup/1.0'})
        with opener.open(req,timeout=290) as response:
            raw=response.read(48*1024*1024+1)
            if len(raw)>48*1024*1024:raise RuntimeError('response too large')
            value=json.loads(raw)
            if not value.get('ok'):raise RuntimeError('request failed')
            return value
    targets=request('targets')['workspaces'];assert len(targets)<=10000 and len(set(targets))==len(targets) and all(UUID.fullmatch(w) for w in targets)
    now=datetime.datetime.now(datetime.timezone.utc);day=now.astimezone(datetime.timezone(datetime.timedelta(hours=9))).date().isoformat()
    state_path=ROOT/'progress.json'
    state=json.loads(state_path.read_text()) if state_path.exists() else {}
    if state.get('day')!=day:state={'day':day,'completed':{},'failed':{}}
    # This dedicated mirror has a strict seven-day retention, including accounts
    # that no longer appear in the active target list. Never traverse other data.
    for folder in ROOT.iterdir():
        if not folder.is_dir() or folder.is_symlink() or not UUID.fullmatch(folder.name):continue
        for archive in folder.glob('*.sealed.json'):
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.sealed\.json',archive.name):continue
            archive_day=datetime.date.fromisoformat(archive.name[:10])
            if (datetime.date.fromisoformat(day)-archive_day).days>=7:archive.unlink()
        if not any(folder.iterdir()):folder.rmdir()
    for workspace in targets:
        completed=state['completed'].get(workspace)
        if completed and completed.get('backupVersion',0)>=9:
            path=ROOT/workspace/completed['file']
            if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest()==completed['sha256']:continue
        for attempt in range(3):
            try:
                if shutil.disk_usage(ROOT).free<2*1024**3:raise RuntimeError('disk reserve reached')
                # Bound the entire independent mirror before adding a new file.
                if sum(p.stat().st_size for p in ROOT.glob('*/*.sealed.json'))>200*1024**2:raise RuntimeError('mirror budget reached')
                result=request('workspace',{'workspaceId':workspace})
                assert result['workspace_id']==workspace and result['archive']['format']=='byeollog-independent-backup-v1'
                assert result.get('backup_version',0)>=9
                folder=ROOT/workspace;folder.mkdir(exist_ok=True,mode=0o700)
                path=folder/(day+'.sealed.json')
                incoming=len((json.dumps(result)+'\n').encode())
                used=sum(p.stat().st_size for p in ROOT.glob('*/*.sealed.json'))
                replaced=path.stat().st_size if path.exists() else 0
                if used-replaced+incoming>200*1024**2:raise RuntimeError('mirror budget reached')
                atomic(path,result)
                # Reopen and verify persistence before marking the account done.
                saved=path.read_bytes();assert json.loads(saved)==result
                state['completed'][workspace]={'file':path.name,'sha256':hashlib.sha256(saved).hexdigest(),'createdAt':result['created_at'],'backupVersion':result['backup_version']}
                state['failed'].pop(workspace,None);atomic(state_path,state)
                for old in sorted(folder.glob('*.sealed.json'),reverse=True)[7:]:old.unlink()
                break
            except Exception as error:
                state['failed'][workspace]={'type':type(error).__name__,'attempt':attempt+1};atomic(state_path,state)
                if attempt<2:time.sleep(10*(attempt+1))
    summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'day':day,'targets':len(targets),'completed':sum(w in state['completed'] for w in targets),'failed':sum(w in state['failed'] for w in targets)}
    atomic(ROOT.parent/'backup-status.json',summary);print(json.dumps(summary))
    return 1 if summary['failed'] or summary['completed']!=len(targets) else 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'ok':False,'type':type(error).__name__}));sys.exit(1)
