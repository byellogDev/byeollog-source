import importlib.util,pathlib,unittest,types,json,queue
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('controller',pathlib.Path(__file__).with_name('soak-controller.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def frame(at=8000):return {'at':at,'code':18,'digest':'synthetic'}
class FinalizationTests(unittest.TestCase):
 def session_fixture(self,drained_peer=False):
  clock=[100.0]
  events=[('original',{'kind':'private_config','config':{'synthetic':True}}),('original',{'kind':'monitor_ready','before':{}}),('candidate',{'kind':'ready'}),('original',{'kind':'frame',**frame(108000)}),('original',{'kind':'monitor_done','after':{}})]
  tail=[('candidate',{'kind':'frame',**frame(108050)})] if drained_peer else []
  class Pipe:
   def write(self,*a):pass
   def flush(self):pass
   def close(self):pass
  class Process:
   def __init__(self,*a,**kw):self.stdin=Pipe();self.stdout=[]
   def poll(self):return None
   def wait(self,**kw):pass
   def terminate(self):pass
  class Queue:
   def __init__(self,**kw):pass
   def get(self,**kw):clock[0]+=2;return events.pop(0)
   def get_nowait(self):
    if not tail:raise queue.Empty()
    return tail.pop(0)
   def empty(self):return not tail
   def put_nowait(self,x):raise AssertionError('Unexpected reader output')
  class Evidence:
   def emit(self,*a,**kw):pass
  inspection={'HostConfig':{'ReadonlyRootfs':True,'Memory':268435456,'PidsLimit':32,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'NanoCpus':250000000},'Config':{'User':'65534:65534','Env':[]},'Mounts':[]}
  fake_process=types.SimpleNamespace(PIPE=-1,DEVNULL=-3,Popen=Process,run=lambda args,**kw:types.SimpleNamespace(returncode=1 if args[1]=='inspect' else 0),TimeoutExpired=TimeoutError)
  with patch.object(m,'time',types.SimpleNamespace(time=lambda:clock[0],monotonic=lambda:clock[0],sleep=lambda _:None)),patch.object(m,'pressure',return_value=False),patch.object(m,'subprocess',fake_process),patch.object(m,'queue',types.SimpleNamespace(Queue=Queue,Empty=queue.Empty)),patch.object(m,'command',side_effect=lambda args,**kw:json.dumps([inspection]) if '--format' not in args else 'synthetic-image'):
   return m.session({'label':'test','workspaceId':'synthetic'},dict(monitor='',observer='',entry='',wsFiles={}),1000,Evidence())
 def test_full_session_surfaces_final_unmatched_donation(self):
  result=self.session_fixture()
  self.assertEqual(result['reason'],'event_mismatch');self.assertTrue(result['reviewRequired']);self.assertEqual(result['comparison']['only']['original'],{'18':1})
 def test_full_session_drains_matching_peer_before_final_verdict(self):
  result=self.session_fixture(drained_peer=True)
  self.assertEqual(result['reason'],'campaign_complete');self.assertEqual(result['comparison']['matched'],{'18':1});self.assertFalse(result.get('reviewRequired',False))
 def test_campaign_reports_review_instead_of_finishing(self):
  records=[]
  class Evidence:
   def __init__(self,*a):pass
   def emit(self,kind,**values):records.append({'kind':kind,**values})
  result={'reason':'event_mismatch','terminalReason':'campaign_complete','reviewRequired':True,'candidateRemoved':True}
  with patch.object(m,'Evidence',Evidence),patch.object(m,'original_state',return_value={'state':'connected'}),patch.object(m,'session',return_value=result):
   m.campaign({'label':'test','workspaceId':'synthetic'},{},m.time.time()+300)
  self.assertTrue(any(x['kind']=='needs_review' and x['reason']=='event_mismatch' for x in records));self.assertFalse(any(x['kind']=='campaign_finished' for x in records))
 def test_final_mismatch_overrides_every_benign_stop(self):
  for reason in ['campaign_complete','duration_reached','broadcast_closed','supervisor_stopped']:
   with self.subTest(reason=reason):
    c=m.Comparison(0);c.add('original',frame());r={'reason':reason}
    m.finalize_comparison(c,r,10000)
    self.assertEqual(r['reason'],'event_mismatch');self.assertTrue(r['reviewRequired']);self.assertEqual(r['terminalReason'],reason)
 def test_matching_drained_peer_preserves_normal_stop(self):
  c=m.Comparison(0);c.add('original',frame());c.add('candidate',frame(8050));r={'reason':'duration_reached'}
  m.finalize_comparison(c,r,10000)
  self.assertEqual(r['reason'],'duration_reached');self.assertFalse(r.get('reviewRequired',False));self.assertEqual(r['comparison']['matched'],{'18':1})
 def test_unresolved_tail_is_a_gap_not_success(self):
  c=m.Comparison(0);c.add('original',frame(9500));r={'reason':'campaign_complete'}
  m.finalize_comparison(c,r,10000)
  self.assertEqual(r['reason'],'comparison_incomplete');self.assertEqual(r['comparisonTailGap']['original'],1);self.assertTrue(r['reviewRequired'])
if __name__=='__main__':unittest.main()
