"""Exercise the installed alert state machine without HTTP, credentials or DB writes."""
import ast
import importlib.util
import pathlib
import sys
import unittest

spec=importlib.util.spec_from_file_location('patcher',pathlib.Path(__file__).with_name('patch-ops-monitor.py'))
patcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(patcher)

# Minimal legacy function, retained to reproduce the original false recovery.
LEGACY='''
LABELS={'channel_state':'수집 채널 상태 이상'}
HEALTH_KEYS={'flush_stalled','channel_state'}
WARNING_KEYS=set()
def advance_alerts(state,bad,now,sample=None):
    for key in LABELS:
        a=state.setdefault(key,{'open':False,'bad':0,'good':0,'lastSent':0,'pending':None})
        if sample is not None:
            observed=sample.get('healthAt')
            if key in HEALTH_KEYS and (not observed or now-stamp(observed)>540):continue
            if observed is None or a.get('lastObserved')==observed:continue
            a['lastObserved']=observed
        is_bad=key in bad
        severity='warning' if key in WARNING_KEYS or (sample is not None and key in sample.get('healthWarnings',[])) else 'critical'
        a['bad']=a['bad']+1 if is_bad else 0;a['good']=0 if is_bad else a['good']+1
        target=True if a['bad']>=2 else False if a['good']>=2 else a['open']
        if target!=a['open']:
            a['open']=target
            a['pending']={'open':target}
    return state
def collect_local():
    if now-stamp(health.get('at'))>540:bad.add('health_stale')
    for key in ('channelErrors','lastEventAt','lastDeliveryAt'):pass
def deliver(state,url,now,sender):
    for key,a in state.items():
        p=a.get('pending');content='test'
        status,body,retry=sender(url+'?wait=true',content)
'''

def extract(source):
    # AST extraction means the real monitor's imports/main/network never run.
    tree=ast.parse(source)
    nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='advance_alerts']
    scope={'LABELS':{'channel_state':'channel','egress_policy':'ports'},
           'HEALTH_KEYS':{'channel_state','egress_policy'},'WARNING_KEYS':set(),'stamp':lambda x:float(x or 0)}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'isolated-advance','exec'),scope)
    return scope['advance_alerts']

SOURCE=pathlib.Path(sys.argv.pop()).read_text(encoding='utf8') if len(sys.argv)>1 and pathlib.Path(sys.argv[-1]).is_file() else LEGACY
NEW=extract(patcher.patch(SOURCE));OLD=extract(SOURCE)

def sample(now, ready=False):
    return {'healthAt':now,'channelRecoveryConfirmed':ready,'healthWarnings':['channel_state']}

class MonitorRecoveryTests(unittest.TestCase):
    def open_incident(self, fn):
        state={}
        for tick in (100,130):fn(state,{'channel_state'},tick,sample(tick))
        self.assertTrue(state['channel_state']['open'])
        state['channel_state']['pending']=None
        return state

    def test_old_false_recovery_reproduced_and_new_blocked(self):
        old,new=self.open_incident(OLD),self.open_incident(NEW)
        for tick in (160,190,220):
            OLD(old,set(),tick,sample(tick));NEW(new,set(),tick,sample(tick))
        self.assertFalse(old['channel_state']['open'])
        self.assertTrue(new['channel_state']['open'])
        self.assertIsNone(new['channel_state']['pending'])

    def test_two_fresh_confirmed_samples_recover(self):
        state=self.open_incident(NEW)
        NEW(state,set(),160,sample(160,True));self.assertTrue(state['channel_state']['open'])
        NEW(state,set(),190,sample(190,True));self.assertFalse(state['channel_state']['open'])

    def test_unknown_breaks_recovery_streak(self):
        state=self.open_incident(NEW)
        NEW(state,set(),160,sample(160,True))
        NEW(state,set(),190,sample(190))
        NEW(state,set(),220,sample(220,True));self.assertTrue(state['channel_state']['open'])

    def test_stale_sample_cannot_clear_pending_incident(self):
        state=self.open_incident(NEW)
        NEW(state,set(),1000,sample(160,True));NEW(state,set(),1030,sample(190,True))
        self.assertTrue(state['channel_state']['open'])

    def test_missing_proof_cancels_queued_false_recovery(self):
        state=self.open_incident(NEW)
        state['channel_state'].update(open=False,pending={'open':False})
        NEW(state,set(),160,sample(160))
        self.assertTrue(state['channel_state']['open']);self.assertIsNone(state['channel_state']['pending'])

    def test_repeated_same_sample_not_counted_twice(self):
        state=self.open_incident(NEW)
        NEW(state,set(),160,sample(160,True));NEW(state,set(),170,sample(160,True))
        self.assertTrue(state['channel_state']['open'])

    def test_new_port_raises_own_alert(self):
        state={}
        for tick in (100,130):NEW(state,{'egress_policy'},tick,{**sample(tick,True),'unapprovedEgressPorts':[9041]})
        self.assertTrue(state['egress_policy']['open']);self.assertEqual(state['egress_policy']['ports'],[9041])

    def test_patcher_fails_on_drift_or_double_apply(self):
        with self.assertRaises(ValueError):patcher.patch(patcher.patch(SOURCE))
        with self.assertRaises(ValueError):patcher.patch('unrecognized source')

if __name__=='__main__':unittest.main()
