"""Bounded streaming multiset comparison; no message bodies are retained."""
from collections import Counter, deque

class Comparison:
    def __init__(self, start_ms, grace_ms=10000, limit=20000):
        self.start = start_ms + 1000
        self.grace = grace_ms
        self.limit = limit
        self.pending = {"original": {}, "candidate": {}}
        self.pending_count = 0
        self.received = {"original": Counter(), "candidate": Counter()}
        self.matched = Counter()
        self.only = {"original": Counter(), "candidate": Counter()}
        self.delay = Counter()
        self.examples = deque(maxlen=20)

    def add(self, source, event):
        if source not in self.pending:
            raise ValueError("unexpected_source")
        if event["at"] < self.start:
            return
        key = (event["code"], event["digest"])
        other = "candidate" if source == "original" else "original"
        self.received[source][str(key[0])] += 1
        opposite = self.pending[other].get(key)
        if opposite:
            at = opposite.popleft()
            self.pending_count -= 1
            if not opposite:
                del self.pending[other][key]
            self.matched[str(key[0])] += 1
            delta = event["at"] - at if source == "candidate" else at - event["at"]
            bucket = next((str(x) for x in [-1000,-100,-20,0,20,100,1000,10000] if delta <= x), "over10000")
            self.delay[bucket] += 1
        else:
            if self.pending_count >= self.limit:
                raise ValueError("comparison_capacity_exceeded")
            self.pending[source].setdefault(key, deque()).append(event["at"])
            self.pending_count += 1

    def expire(self, now_ms, final=False):
        cutoff = now_ms - (1000 if final else self.grace)
        for source, values in self.pending.items():
            for key, times in list(values.items()):
                while times and times[0] < cutoff:
                    at = times.popleft()
                    self.pending_count -= 1
                    self.only[source][str(key[0])] += 1
                    self.examples.append({'source':source,'code':key[0],'digest':key[1],'at':at})
                if not times:
                    del values[key]

    def summary(self):
        return {"received": {s: dict(v) for s,v in self.received.items()},
                "matched": dict(self.matched), "only": {s: dict(v) for s,v in self.only.items()},
                "pendingComparison": self.pending_count, "candidateMinusOriginalMsBuckets": dict(self.delay),
                "unmatchedDigestExamples":list(self.examples)}

    def mismatched(self):
        return any(sum(v.values()) for v in self.only.values())
