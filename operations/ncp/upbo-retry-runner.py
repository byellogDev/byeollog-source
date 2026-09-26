#!/usr/bin/env python3
"""Keep the minute timer; skip outbound requests after consecutive empty claims."""
import fcntl,json,math,os,pathlib,sys,time,urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect refused')

def next_state(previous,result,now):
    claimed=result.get('claimed')
    if type(claimed) is not int or claimed<0:raise ValueError('invalid retry response')
    empty=min(4,int(previous.get('empty',0))+1) if claimed==0 else 0
    delay=(60,60,120,240,300)[empty]
    return {'version':1,'empty':empty,'at':now,'nextAt':now+delay,'delaySeconds':delay}

def due(state,now):
    try:
        at=float(state['at']);next_at=float(state['nextAt'])
        return not (state.get('version')==1 and math.isfinite(at) and math.isfinite(next_at) and at<=now<next_at<=at+300)
    except (KeyError,TypeError,ValueError):return True

def run(root,request,now=time.time):
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (root/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        path=root/'state.json'
        try:state=json.loads(path.read_text())
        except (FileNotFoundError,ValueError):state={}
        if not isinstance(state,dict):state={}
        if not due(state,now()):return {'skipped':True,'reason':'empty_backoff','nextAt':state['nextAt']}
        try:
            result=request();new=next_state(state,result,now())
        except Exception:
            # A failed/unknown response must not extend empty-queue backoff.
            path.unlink(missing_ok=True)
            raise
        tmp=root/'state.tmp';tmp.write_text(json.dumps(new));tmp.chmod(0o600);tmp.replace(path)
        return {**result,'pollDelaySeconds':new['delaySeconds']}

def main():
    os.umask(0o077)
    credential=pathlib.Path(os.environ['CREDENTIALS_DIRECTORY'])/'request-header'
    header=credential.read_text().strip()
    if '\n' in header or not header.lower().startswith('authorization: bearer '):raise ValueError('invalid credential format')
    authorization=header.split(':',1)[1].strip()
    def request():
        req=urllib.request.Request('https://byeollog.com/api/upbo-retry',headers={'Authorization':authorization,'User-Agent':'byeollog-upbo-retry/2'})
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=50) as response:
            raw=response.read(65537)
            if len(raw)>65536:raise ValueError('response too large')
            return json.loads(raw)
    print(json.dumps(run(pathlib.Path('/var/lib/byeollog-upbo-retry'),request)))

if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'ok':False,'type':type(error).__name__}));sys.exit(1)
