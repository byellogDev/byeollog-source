"""Read-only incident report. Local bounded metadata and monitor DB; no API calls."""
import argparse
import collections
from contextlib import closing
import datetime
import json
import math
import pathlib
import sqlite3
import time


def report(directory,database,start,end):
    if not (math.isfinite(start) and math.isfinite(end) and 0<end-start<=48*3600):
        raise ValueError('interval_must_be_at_most_48_hours')
    counts=collections.Counter();latencies=[];failures=[];contexts=[];cycles=collections.Counter()
    first=None;last=None;skipped=0;incomplete=0;limited=False
    for suffix in ['']+['.'+str(i) for i in range(1,16)]:
        path=pathlib.Path(directory)/('diagnostics.jsonl'+suffix)
        try:
            with path.open(encoding='utf8') as source:
                for _ in range(100000):
                    line=source.readline(8194)
                    if not line:break
                    if len(line)>8192:raise ValueError('oversized_record')
                    try:r=json.loads(line)
                    except ValueError:skipped+=1;continue
                    at=r.get('at') if isinstance(r,dict) else None
                    if type(at) not in (int,float) or not start<=at<=end:continue
                    first=at if first is None else min(first,at);last=at if last is None else max(last,at)
                    if r.get('event')=='api_request':
                        outcome=r.get('outcome','unknown')
                        counts[outcome]+=1
                        if type(r.get('elapsedMs'))==int:latencies.append(r['elapsedMs'])
                        if outcome!='ok':
                            if len(failures)<1000:failures.append(r)
                            else:limited=True
                    elif r.get('event')=='failure_context':
                        if len(contexts)<1000:contexts.append(r)
                        else:limited=True
                    elif r.get('event')=='maintenance':cycles[r.get('error') or 'ok']+=1
                else:limited=True
        except FileNotFoundError:continue
    health={'samples':0,'nonzero':{k:0 for k in ('channelErrors','pending','deadLetters')},
            'missingFields':0,'gapsOver120Seconds':0,'firstAt':None,'lastAt':None}
    previous=None
    with closing(sqlite3.connect(pathlib.Path(database).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        for at,body in db.execute('select at,body from samples where at>=? and at<=? order by at',(start,end)):
            try:r=json.loads(body)
            except ValueError:incomplete+=1;continue
            health['samples']+=1
            if previous is not None and at-previous>120:health['gapsOver120Seconds']+=1
            if health['firstAt'] is None:health['firstAt']=at
            previous=at;health['lastAt']=at
            for key in health['nonzero']:
                value=r.get(key)
                if type(value) not in (int,float):health['missingFields']+=1
                elif value>0:health['nonzero'][key]+=1
    latencies.sort()
    return {'schema':1,'interval':{'from':start,'to':end},
            'coverage':{'firstRecordAt':first,'lastRecordAt':last,'retentionMayLimitInterval':first is None or first>start+90},
            'requests':dict(counts),'maintenance':dict(cycles),
            'latencyMs':({'p50':latencies[len(latencies)//2],
                          'p95':latencies[min(len(latencies)-1,math.ceil(len(latencies)*.95)-1)],
                          'max':latencies[-1]} if latencies else None),
            'failures':sorted(failures,key=lambda r:r['at']),'failureContexts':sorted(contexts,key=lambda r:r['at']),
            'collectionHealth':health,'malformedLogRecords':skipped,'malformedHealthRows':incomplete,
            'detailLimitReached':limited,'donationCompletenessVerified':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--since',required=True,help='ISO timestamp with timezone')
    parser.add_argument('--until',help='ISO timestamp with timezone; default now')
    parser.add_argument('--directory',default='/var/lib/byeollog-egress')
    parser.add_argument('--database',default='/var/lib/byeollog-ops/monitor/metrics.sqlite3')
    args=parser.parse_args()
    def stamp(value):
        parsed=datetime.datetime.fromisoformat(value)
        if parsed.tzinfo is None:raise ValueError('timezone_required')
        return parsed.timestamp()
    print(json.dumps(report(args.directory,args.database,stamp(args.since),
                            stamp(args.until) if args.until else time.time()),sort_keys=True))
