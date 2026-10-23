"""Business multiset equality plus independent bounded, private wire diagnostics."""
from collections import Counter, deque
import re,json

BUSINESS_FIELDS = {'room.broadcasterId','room.chatNumber','event','event.action'} | {
    'event.message.'+k for k in ['message','userId','userNickname','bjId','count','imageUrl','fromVod','relaysBroad','fromStation']}

def safe_record(event):
    def digest(v):
        if type(v) is not str or not re.fullmatch('[0-9a-f]{64}',v):raise ValueError('comparison_diagnostic_invalid')
        return v
    def fp(v):
        if type(v) is not dict or type(v.get('bytes')) is not int or not 0<=v['bytes']<=262144:raise ValueError('comparison_diagnostic_invalid')
        return {'digest':digest(v.get('digest')),'bytes':v['bytes']}
    if event.get('schema')!=2 or event.get('semanticKind') not in ['event','ignored']:raise ValueError('comparison_schema_invalid')
    if type(event.get('at')) is not int or type(event.get('code')) is not int or event['code'] not in [5,18,26,33,86,87,103,105,107,109,121,125]:raise ValueError('comparison_diagnostic_invalid')
    fields=event.get('fields');business=event.get('business')
    if type(fields) is not list or len(fields)>256 or type(business) is not dict or not business or not set(business)<=BUSINESS_FIELDS:raise ValueError('comparison_diagnostic_invalid')
    return {'schema':2,'at':event['at'],'code':event['code'],'semanticKind':event['semanticKind'],
            'digest':digest(event.get('digest')),'rawDigest':digest(event.get('rawDigest')),
            'fields':[fp(v) for v in fields],'business':{k:fp(v) for k,v in business.items()}}

def difference(a,b):
    return {'wireFields':[i for i in range(max(len(a['fields']),len(b['fields'])))
                          if (a['fields'][i] if i<len(a['fields']) else None)!=(b['fields'][i] if i<len(b['fields']) else None)],
            'businessFields':[k for k in sorted(set(a['business'])|set(b['business'])) if a['business'].get(k)!=b['business'].get(k)]}

class Comparison:
    def __init__(self,start_ms,grace_ms=10000,limit=20000,on_diagnostic=None):
        self.start=start_ms+1000;self.grace=grace_ms;self.limit=limit
        self.pending={'original':{},'candidate':{}};self.pending_count=0;self.pending_bytes=0
        self.received={s:Counter() for s in self.pending};self.only={s:Counter() for s in self.pending}
        self.matched=Counter();self.ignored=Counter();self.raw_differences=Counter();self.delay=Counter()
        self.examples=deque(maxlen=20);self.diagnostics=deque(maxlen=20)
        self.on_diagnostic=on_diagnostic or (lambda _:None)
    def diagnostic(self,kind,**detail):
        item={'diagnosticKind':kind,**detail};self.diagnostics.append(item);self.on_diagnostic(item)
    def add(self,source,event):
        if source not in self.pending:raise ValueError('unexpected_source')
        e=safe_record(event)
        if e['at']<self.start:return
        key=(e['code'],e['semanticKind'],e['digest']);code=str(e['code'])
        other='candidate' if source=='original' else 'original';self.received[source][code]+=1
        opposite=self.pending[other].get(key)
        if opposite and abs(e['at']-opposite[0]['at'])<=self.grace:
            peer=opposite.popleft();self.pending_count-=1;self.pending_bytes-=len(json.dumps(peer))
            if not opposite:del self.pending[other][key]
            (self.matched if e['semanticKind']=='event' else self.ignored)[code]+=1
            a,b=(e,peer) if source=='original' else (peer,e)
            delta=b['at']-a['at'];bucket=next((str(x) for x in [-1000,-100,-20,0,20,100,1000,10000] if delta<=x),'over10000');self.delay[bucket]+=1
            if a['rawDigest']!=b['rawDigest']:
                self.raw_differences[code]+=1
                self.diagnostic('wire_only_difference',original=a,candidate=b,**difference(a,b))
        else:
            size=len(json.dumps(e))
            if self.pending_count>=self.limit or self.pending_bytes+size>16*1024*1024:raise ValueError('comparison_capacity_exceeded')
            self.pending_bytes+=size
            self.pending[source].setdefault(key,deque()).append(e);self.pending_count+=1
    def expire(self,now_ms,final=False):
        cutoff=now_ms-(1000 if final else self.grace)
        # Gather before removal so both sides retain a possible-peer diagnostic.
        expired=[(s,k,e) for s,values in self.pending.items() for k,events in values.items() for e in events if e['at']<cutoff]
        for source,key,e in expired:
            other='candidate' if source=='original' else 'original'
            peers=[p for k,events in self.pending[other].items() if k[0]==key[0] for p in events if abs(p['at']-e['at'])<=self.grace]
            peer=min(peers,key=lambda p:abs(p['at']-e['at'])) if peers else None
            self.only[source][str(key[0])]+=1;self.examples.append({'source':source,**e})
            self.diagnostic('unmatched_event',source=source,event=e,possiblePeer=peer,
                            pairing='time_proximity_not_identity' if peer else 'none',**(difference(e,peer) if peer else {}))
        for source,values in self.pending.items():
            for key,events in list(values.items()):
                kept=deque(e for e in events if e['at']>=cutoff);self.pending_count-=len(events)-len(kept)
                self.pending_bytes-=sum(len(json.dumps(e)) for e in events if e['at']<cutoff)
                if kept:values[key]=kept
                else:del values[key]
    def summary(self):
        return {'comparisonSchema':2,'received':{s:dict(v) for s,v in self.received.items()},'matched':dict(self.matched),
                'ignoredMatched':dict(self.ignored),'rawDifferenceCounts':dict(self.raw_differences),'only':{s:dict(v) for s,v in self.only.items()},
                'pendingComparison':self.pending_count,'candidateMinusOriginalMsBuckets':dict(self.delay),
                'unmatchedDigestExamples':list(self.examples),'diagnosticExamples':list(self.diagnostics)}
    def mismatched(self):return any(sum(v.values()) for v in self.only.values())
