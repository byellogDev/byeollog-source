#!/usr/bin/env python3
"""Prune cloud wallpaper history and refresh precisely identified local mirrors."""
import datetime,fcntl,hashlib,json,math,os,pathlib,re,sys,time,urllib.request,urllib.error
ROOT=pathlib.Path('/var/lib/byeollog-ops/independent-backups')
CONFIG=pathlib.Path('/etc/byeollog-backup-runner.json')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect refused')
def atomic(path,value):
    if path.is_symlink():raise RuntimeError('symlink target refused')
    owner=path.stat() if path.exists() else None
    tmp=path.with_suffix('.retention.tmp')
    if tmp.is_symlink():raise RuntimeError('symlink temporary file refused')
    tmp.write_text(json.dumps(value)+'\n');tmp.chmod(0o600)
    if owner is not None:os.chown(tmp,owner.st_uid,owner.st_gid)
    tmp.replace(path)
def timestamp_ms(value):
    date=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if date.tzinfo is None:raise ValueError('timezone required')
    date=date.astimezone(datetime.timezone.utc)
    return date.isoformat(timespec='milliseconds')

def mirror_hashes(paths):
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}

def checkpoint_valid(saved,item,paths,now):
    try:
        if not isinstance(saved,dict) or saved.get('version')!=1:return False
        if not item.get('updated_at') or saved.get('sourceVersion')!=item['updated_at']:return False
        checked=float(saved['checkedAt']);deadline=float(saved['nextReviewAt'])
        if not math.isfinite(checked) or not math.isfinite(deadline) or not checked<=now<deadline<=checked+86400000:return False
        return saved.get('mirrors')==mirror_hashes(paths)
    except (KeyError,TypeError,ValueError,OSError):return False

def make_checkpoint(result,item,paths,now):
    value=result.get('checkpoint')
    if result.get('changed') or not isinstance(value,dict) or value.get('version')!=1:return None
    if not item.get('updated_at') or value.get('sourceVersion')!=item['updated_at']:return None
    deadline=value.get('nextReviewAt')
    if not isinstance(deadline,(int,float)) or isinstance(deadline,bool) or not math.isfinite(deadline) or deadline<=now:return None
    return {**value,'nextReviewAt':min(deadline,now+86400000),'checkedAt':now,'mirrors':mirror_hashes(paths)}
def resolve_source(copy,items):
    prefix='workspaces/'+copy['workspace_id']+'/daily/'
    names={item['name'] for item in items}
    source=copy.get('source_path')
    if source:
        if not source.startswith(prefix) or '..' in source:raise ValueError('source scope mismatch')
        return source if source in names else None
    candidates=[]
    for item in items:
        name=item['name']
        if not name.startswith(prefix):continue
        if copy.get('reused'):
            if not item.get('created_at'):raise ValueError('source metadata unavailable')
            same=timestamp_ms(item['created_at'])==timestamp_ms(copy['created_at'])
        else:
            stamp=datetime.datetime.fromisoformat(copy['created_at'].replace('Z','+00:00')).astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            same=name==prefix+stamp.replace(':','-').replace('.','-')+'__daily.json.gz'
        if same:candidates.append(name)
    if len(candidates)>1:raise ValueError('ambiguous source')
    return candidates[0] if candidates else None
def request(opener,cfg,mode,body=None,metrics=None,sleep=time.sleep):
    for attempt in range(3):
        req=urllib.request.Request('https://byeollog.com/api/backups?cron='+mode,data=json.dumps(body).encode() if body else None,headers={'Authorization':'Bearer '+cfg['secret'],'Content-Type':'application/json'})
        try:
            with opener.open(req,timeout=90) as response:
                raw=response.read(48*1024*1024+1)
                if len(raw)>48*1024*1024:raise RuntimeError('response too large')
                value=json.loads(raw)
                if not value.get('ok'):raise RuntimeError('retention request failed')
                return value
        except (urllib.error.URLError,TimeoutError) as error:
            status=error.code if isinstance(error,urllib.error.HTTPError) else None
            if status is not None:error.close()
            retryable=status in (408,429,500,502,503,504) if status is not None else True
            if metrics is not None:
                key=str(status or 'network');metrics['httpErrors'][key]=metrics['httpErrors'].get(key,0)+1
            if not retryable or attempt==2:raise
            if metrics is not None:metrics['retries']+=1
            sleep((2,5)[attempt])
def main():
    os.umask(0o077)
    with (ROOT/'runner.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        cfg=json.loads(CONFIG.read_text())
        opener=urllib.request.build_opener(NoRedirect())
        report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checked':0,'skippedUnchanged':0,'changed':0,'tilesRemoved':0,'sessionsRemoved':0,'mirrorsRefreshed':0,'failed':0,'retries':0,'httpErrors':{}}
        items=request(opener,cfg,'retention-list',metrics=report)['items'];assert len(items)<=10000
        mirrors={};sources={};missing=[]
        for folder in ROOT.iterdir():
            if not folder.is_dir() or folder.is_symlink() or not re.fullmatch(r'[a-f0-9-]{36}',folder.name):continue
            for path in folder.glob('*.sealed.json'):
                if path.is_symlink() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.sealed\.json',path.name):continue
                copy=json.loads(path.read_text());assert copy['workspace_id']==folder.name
                source=resolve_source(copy,items)
                if source is None:
                    # Independent copies intentionally survive remote deletion.
                    # Preserve their original date/content and existing seven-day expiry.
                    missing.append(path)
                else:
                    mirrors[path]=copy;sources.setdefault(source,[]).append(path)
        state_path=ROOT/'progress.json';state=json.loads(state_path.read_text());matched=set()
        checkpoint_path=ROOT/'retention-checkpoints.json'
        try:checkpoints=json.loads(checkpoint_path.read_text())
        except (FileNotFoundError,ValueError):checkpoints={}
        if not isinstance(checkpoints,dict):checkpoints={}
        checkpoints={k:v for k,v in checkpoints.items() if k in {item['name'] for item in items}}
        for item in items:
            try:
                paths=sources.get(item['name'],[])
                if checkpoint_valid(checkpoints.get(item['name']),item,paths,time.time()*1000):
                    report['skippedUnchanged']+=1;matched.update(paths);continue
                # A failed attempt cannot leave an older success eligible for reuse.
                checkpoints.pop(item['name'],None);atomic(checkpoint_path,checkpoints)
                result=request(opener,cfg,'retention-file',{'path':item['name']},report)
                assert result['path']==item['name']
                report['checked']+=1;report['changed']+=int(result['changed'])
                report['tilesRemoved']+=result['removedTiles'];report['sessionsRemoved']+=result['removedBroadcasts']
                for path in sources.get(item['name'],[]):
                    copy=mirrors[path]
                    assert copy['workspace_id']==result['workspace_id']
                    archive=result.get('archive')
                    assert archive and archive.get('format')=='byeollog-independent-backup-v1'
                    assert re.fullmatch(r'[a-f0-9]{64}',archive.get('sha256',''))
                    updated={**copy,'source_path':result['path'],'archive':archive,'wallpaperRetentionCutoff':result['cutoff']}
                    atomic(path,updated);assert json.loads(path.read_text())==updated
                    completed=state.get('completed',{}).get(copy['workspace_id'])
                    if completed and completed['file']==path.name:
                        completed['sha256']=hashlib.sha256(path.read_bytes()).hexdigest();atomic(state_path,state)
                    matched.add(path);report['mirrorsRefreshed']+=1
                saved=make_checkpoint(result,item,paths,time.time()*1000)
                if saved is not None:checkpoints[item['name']]=saved
                atomic(checkpoint_path,checkpoints)
            except Exception as error:
                report['failed']+=1
                print(json.dumps({'errorType':type(error).__name__,'httpStatus':getattr(error,'code',None),'itemTag':hashlib.sha256(item['name'].encode()).hexdigest()[:12]}),flush=True)
        report['unmatchedMirrors']=len(set(mirrors)-matched)
        report['sourceMissingMirrors']=len(missing)
        report['sourceMissingPolicy']='preserve_until_original_seven_day_expiry'
        report['ok']=not report['failed'] and not report['unmatchedMirrors']
        report['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        atomic(ROOT.parent/'wallpaper-retention-status.json',report);print(json.dumps(report))
        return 0 if report['ok'] else 1
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'ok':False,'type':type(error).__name__}));sys.exit(1)
