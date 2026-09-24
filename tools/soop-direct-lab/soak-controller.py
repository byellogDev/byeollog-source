"""Separate 48-hour research supervisor. Never writes operating data or files.
Private configuration: target workspace IDs, direct adapter and pinned ws source only.
Provider credentials exist only in monitor/controller/candidate memory and pipes.
"""
import collections, datetime, hashlib, importlib.util, json, os, pathlib
import queue, secrets, signal, subprocess, sys, threading, time, uuid

BASE = pathlib.Path(__file__).resolve().parent
compare_path = BASE / "soak-compare.py"
if not compare_path.exists():
    compare_path = BASE.parent / "soop-browserless-lab" / "soak-compare.py"
spec = importlib.util.spec_from_file_location("compare", compare_path)
compare_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare_module)
Comparison = compare_module.Comparison
STOP = threading.Event()
CANARY_PASSED = threading.Event()
PROD = "soop-chat-gateway-soop-gateway-1"

def command(args, timeout=15):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=timeout)

def original_state(workspace):
    state = json.loads(command(["docker","exec",PROD,"cat","/var/lib/byeollog/worker-state.json"]))
    tag = hashlib.sha256(workspace.encode()).hexdigest()[:12]
    channel = next((c for c in state["channels"] if c["workspace"] == tag), {})
    return {"state": channel.get("state"), "lastErrorCode": channel.get("lastErrorCode"),
            "pending": state["queue"]["pending"], "deadLetters": state["queue"]["deadLetters"]}

def resource(names):
    lines = command(["docker","stats","--no-stream","--format","{{json .}}",*names])
    return [{k: item.get(k) for k in ["Name","CPUPerc","MemUsage","MemPerc","PIDs"]}
            for item in map(json.loads, lines.splitlines())]

def pressure():
    mem = dict((line.split(':')[0],int(line.split()[1])) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
    return mem['MemAvailable'] < 1024 * 1024

class Evidence:
    def __init__(self, label):
        self.path = BASE / (label + ".jsonl")
        self.label = label
    def emit(self, kind, **values):
        record = {"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"target":self.label,"kind":kind,**values}
        # A per-target 32 MiB ceiling is an abort, never silent log truncation.
        if self.path.exists() and self.path.stat().st_size > 32*1024*1024:
            raise RuntimeError("evidence_capacity_exceeded")
        with self.path.open('a',encoding='utf-8') as f:
            f.write(json.dumps(record,separators=(',',':'))+'\n')

def finalize_comparison(comparison, report, end_ms):
    comparison.expire(end_ms, final=True)
    report['comparison'] = comparison.summary()
    # A benign transport stop cannot hide a mismatch found only at finalization.
    # The last second is deliberately outside the strict comparison interval;
    # unresolved entries there are a gap, never evidence of successful delivery.
    gap = {source: sum(len(times) for times in entries.values())
           for source, entries in comparison.pending.items()}
    report['comparisonTailGap'] = gap
    reason = ('event_mismatch' if comparison.mismatched() else
              'comparison_incomplete' if any(gap.values()) else None)
    if reason:
        report['terminalReason'] = report['reason']
        report['reason'] = reason
        report['reviewRequired'] = True

def session(target, bundle, end, evidence):
    events = queue.Queue(maxsize=5000)
    overflow = threading.Event()
    processes = []
    readers = []
    candidate = None
    name = "byeollog-soak-" + target['label'] + '-' + uuid.uuid4().hex[:8]
    report = {"reason":None,"ready":False,"candidateRemoved":True}
    comparison = None
    end_at = None
    original_last = candidate_last = time.monotonic()
    ready_since = None
    salt = secrets.token_hex(32)
    def start(source,args,data):
        p = subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        processes.append(p)
        def reader():
            for line in p.stdout:
                try:
                    item=json.loads(line)
                    events.put_nowait((source,item))
                except Exception:
                    overflow.set()
                    break
        thread=threading.Thread(target=reader,daemon=True)
        readers.append(thread);thread.start()
        p.stdin.write(json.dumps(data)+'\n');p.stdin.flush()
        return p
    try:
        if pressure():
            raise RuntimeError('host_memory_pressure')
        image = command(['docker','inspect','--format','{{.Image}}',PROD]).strip()
        duration = min(172800000, max(0,int((end-time.time())*1000)-60000))
        if duration < 60000:
            report['reason']='campaign_complete';return report
        monitor = start('original',['docker','exec','-i',PROD,'node','--input-type=module','-e',bundle['monitor']],
                        {'workspaceId':target['workspaceId'],'salt':salt,'durationMs':duration})
        private = None
        next_beat = 0;next_snapshot = time.monotonic()+60;started=time.monotonic()
        while not STOP.is_set() and time.time() < end:
            now = time.monotonic()
            if overflow.is_set():raise RuntimeError('observation_capacity_exceeded')
            if now >= next_beat:
                for p in processes:
                    if p.poll() is None:
                        try:p.stdin.write('{}\n');p.stdin.flush()
                        except BrokenPipeError:pass
                next_beat=now+10
            if not report['ready'] and now-started>100:raise RuntimeError('startup_timeout')
            if report['ready']:
                if now-original_last>50:raise RuntimeError('original_observation_stale')
                if not end_at and now-candidate_last>40:raise RuntimeError('candidate_observation_stale')
            try:source,event=events.get(timeout=1)
            except queue.Empty:
                if monitor.poll() is not None:
                    report['reason']='original_monitor_exited';break
                if candidate is not None and candidate.poll() is not None and not end_at:
                    report['reason']='candidate_exited';break
                source=None;event={}
            kind=event.get('kind')
            if source=='original':original_last=now
            if source=='candidate':candidate_last=now
            if kind=='private_config':private=event['config'];continue
            if kind=='frame':
                if comparison and (not end_at or event['at']<end_at-1000):comparison.add(source,event)
            elif kind=='monitor_ready':
                if not private:raise RuntimeError('missing_private_config')
                private.update(wsFiles=bundle['wsFiles'])
                code=bundle['observer']+'\n'+bundle['entry']
                args=['docker','run','--rm','-i','--name',name,'--label','byeollog.research=soak',
                      '--read-only','--no-healthcheck','--tmpfs','/tmp:rw,noexec,nosuid,size=16m,mode=1777',
                      '--tmpfs','/var/lib/byeollog:rw,noexec,nosuid,size=1m,mode=1777',
                      '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=32',
                      '--memory=256m','--memory-swap=256m','--cpus=0.25','--log-driver=none',
                      '--user','65534:65534','--entrypoint=node',image,'--max-old-space-size=128','--input-type=module','-e',code]
                candidate=start('candidate',args,private);private=None
                evidence.emit('session_start',original=event['before'],candidate=name,image=image)
                # Inspect actual runtime settings instead of assuming flags applied.
                inspected=None
                for attempt in range(20):
                    try:inspected=json.loads(command(['docker','inspect',name]))[0];break
                    except Exception:time.sleep(0.25)
                if inspected is None:raise RuntimeError('candidate_inspection_failed')
                host=inspected['HostConfig'];env=inspected['Config'].get('Env',[])
                mounts=inspected.get('Mounts',[])
                host_mounts=[m for m in mounts if m.get('Type')!='tmpfs' or m.get('Destination') not in ['/tmp','/var/lib/byeollog']]
                isolated=(host['ReadonlyRootfs'] and host['Memory']==268435456 and host['PidsLimit']==32
                          and not host_mounts and inspected['Config']['User']=='65534:65534'
                          and 'ALL' in host.get('CapDrop',[]) and not host.get('Privileged')
                          and 'no-new-privileges' in host.get('SecurityOpt',[])
                          and host.get('NanoCpus')==250000000 and not host.get('PortBindings')
                          and not any(any(x in e.split('=')[0] for x in ['SECRET','TOKEN','SUPABASE','DATABASE']) for e in env))
                evidence.emit('isolation',passed=bool(isolated),memoryLimit=host['Memory'],pidsLimit=host['PidsLimit'],user=inspected['Config']['User'],hostMounts=len(host_mounts))
                if not isolated:raise RuntimeError('container_isolation_failed')
            elif kind=='ready':
                report['ready']=True;ready_since=now;comparison=Comparison(int(time.time()*1000));evidence.emit('ready')
            elif kind in ['telemetry','original_health']:
                evidence.emit(kind,**{k:v for k,v in event.items() if k not in ['kind','at']})
            elif kind=='abort':
                end_at=int(time.time()*1000)
                report['reason']=event['reason'];break
            elif kind=='result':
                end_at=int(time.time()*1000)
                report.update(reason=event.get('reason'),candidateCounts=event.get('counts',{}))
                evidence.emit('candidate_result',ready=event.get('ready'),reason=event.get('reason'),stage=event.get('stage'),counts=event.get('counts',{}),transport=event.get('transport',{}),unmappedCodeCounts=event.get('unknownCodes',{}))
                if report['reason']!='duration_reached':break
            elif kind=='monitor_done':
                end_at=end_at or int(time.time()*1000)
                report['after']=event.get('after');break
            if comparison:
                comparison.expire(int(time.time()*1000))
                if comparison.mismatched():raise RuntimeError('event_mismatch')
                if target['label']=='test' and not CANARY_PASSED.is_set() and ready_since and now-ready_since>=60 and sum(comparison.matched.values())>=1:
                    evidence.emit('canary_passed',connectedSeconds=now-ready_since,matched=sum(comparison.matched.values()))
                    CANARY_PASSED.set()
            if now>=next_snapshot:
                if pressure():raise RuntimeError('host_memory_pressure')
                evidence.emit('resources',containers=resource([PROD]+([name] if candidate and candidate.poll() is None else [])))
                if comparison:evidence.emit('comparison',**comparison.summary())
                next_snapshot=now+60
        if STOP.is_set():report['reason']='supervisor_stopped'
        if not report['reason']:report['reason']='campaign_complete'
    except Exception as error:
        reason=str(error)
        report['reason']=reason if reason.replace('_','').isalnum() and len(reason)<70 else 'supervisor_error'
    finally:
        end_at=end_at or int(time.time()*1000)
        for p in processes:
            try:p.stdin.close()
            except Exception:pass
        if candidate is not None:
            try:
                subprocess.run(['docker','stop','--time','3',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
                report['candidateRemoved']=False
                for attempt in range(20):
                    if subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10).returncode!=0:
                        report['candidateRemoved']=True;break
                    time.sleep(0.25)
            except Exception:report['candidateRemoved']=False
        for p in processes:
            try:p.wait(timeout=6)
            except subprocess.TimeoutExpired:p.terminate()
        for thread in readers:thread.join(timeout=1)
        if comparison:
            # Processes are closed before draining so a busy room cannot extend
            # shutdown indefinitely. Evidence after the common end is separate.
            outside={'original':0,'candidate':0}
            for _ in range(5000):
                try:source,event=events.get_nowait()
                except queue.Empty:break
                if event.get('kind')=='frame':
                    if event['at'] < end_at:comparison.add(source,event)
                    else:outside[source]+=1
            report['outsideCommonWindow']=outside
            finalize_comparison(comparison,report,end_at)
            if overflow.is_set() or not events.empty() or any(t.is_alive() for t in readers):
                report['terminalReason']=report.get('terminalReason',report['reason'])
                report['reason']='observation_drain_incomplete'
                report['reviewRequired']=True
        evidence.emit('session_end',**report)
    return report

def campaign(target,bundle,end):
    evidence=Evidence(target['label']);last=None
    try:
        evidence.emit('campaign_start',deadline=datetime.datetime.fromtimestamp(end,datetime.timezone.utc).isoformat())
        while not STOP.is_set() and time.time()<end-60:
            if target['label']!='test' and not CANARY_PASSED.is_set():
                if last!='waiting_for_canary':evidence.emit('waiting_for_canary',reason='test_live_comparison_required')
                last='waiting_for_canary';STOP.wait(15);continue
            current=original_state(target['workspaceId'])
            if current['state']!='connected':
                if current!=last:evidence.emit('waiting',original=current)
                last=current;STOP.wait(60);continue
            result=session(target,bundle,end,evidence)
            if not result['candidateRemoved']:
                evidence.emit('needs_review',reason='candidate_cleanup_failed');STOP.set();return
            if result.get('reviewRequired'):
                evidence.emit('needs_review',reason=result['reason']);return
            if result['reason'] in ['campaign_complete','supervisor_stopped']:break
            if result['reason']=='duration_reached':
                evidence.emit('renewal_gap',reason='bounded_session_or_provider_expiry');STOP.wait(60);continue
            if result['reason']=='original_not_ready':STOP.wait(60);continue
            if result['reason']=='observation_token_wait':
                evidence.emit('waiting_for_token',reason='operating_collector_owns_refresh');STOP.wait(60);continue
            # Only an independently observed offline broadcast can restart
            # automatically. Unexpected original/candidate failure halts this target.
            if result['reason'] in ['original_socket_closed','original_state_changed','original_room_changed','socket_closed','broadcast_closed','broadcast_offline']:
                STOP.wait(20)
                current=original_state(target['workspaceId'])
                if current['state']=='waiting_for_live' and current['lastErrorCode']=='broadcast_offline':
                    evidence.emit('broadcast_ended',original=current);STOP.wait(60);continue
            evidence.emit('needs_review',reason=result['reason']);return
        evidence.emit('campaign_finished',stopped=STOP.is_set())
    except Exception:
        evidence.emit('needs_review',reason='campaign_failed')

def main():
    os.umask(0o077)
    bundle=json.loads((BASE/'config.json').read_text())
    end=float(bundle['endEpoch'])
    if not time.time()<end<=time.time()+172801:raise RuntimeError('invalid_campaign_deadline')
    targets=bundle['targets']
    if len(targets)>3 or len({t['workspaceId'] for t in targets})!=len(targets):raise RuntimeError('invalid_target_set')
    for t in targets:
        if t['label'] not in ['test','observer-a','observer-b']:raise RuntimeError('invalid_target_label')
    for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda *_:STOP.set())
    workers=[threading.Thread(target=campaign,args=(t,bundle,end)) for t in targets]
    for worker in workers:worker.start()
    for worker in workers:worker.join()

if __name__=='__main__':main()
