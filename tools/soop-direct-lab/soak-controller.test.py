import importlib.util,pathlib,unittest,types,json,queue
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('controller',pathlib.Path(__file__).with_name('soak-controller.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def frame(at=8000):return {'at':at,'code':18,'digest':'synthetic'}
class ConnectionDiagnosticTests(unittest.TestCase):
 def test_close_code_survives_without_peer_reason_or_unknown_fields(self):
  d=m.safe_connection_diagnostic({'reason':'socket_closed','stage':'receiving','transport':{'closeCode':1008,'closeReasonBytes':20,'connectedMs':1569918,'closeReason':'private-marker','token':'private-marker'}})
  self.assertEqual(d['transport'],{'closeCode':1008,'closeReasonBytes':20,'connectedMs':1569918})
  self.assertEqual(d['stage'],'receiving');self.assertEqual(d['reason'],'socket_closed')
  self.assertNotIn('private-marker',json.dumps(d))
 def test_untrusted_metadata_is_filtered(self):
  d=m.safe_connection_diagnostic({'reason':'private-marker','stage':'private-marker','transport':{'closeCode':True,'closeReasonBytes':124,'elapsedMs':-1,'lastPacketCode':'private-marker'}})
  self.assertEqual(d,{'reason':'connection_failed','stage':None,'transport':{}})

class FinalizationTests(unittest.TestCase):
 def session_fixture(self,drained_peer=False,diagnostic=None,before_ready=False,replacement=False,basis=None):
  clock=[100.0]
  events=[('original',{'kind':'private_config','config':{'synthetic':True}}),('original',{'kind':'monitor_ready','before':{}}),('candidate',{'kind':'ready'}),('original',{'kind':'frame',**frame(108000)}),('original',{'kind':'monitor_done','after':{}})]
  evidence=[]
  writes=[]
  if replacement:
   events.insert(3,('original',{'kind':'private_replacement','config':{'accessToken':'private-marker','broadcasterId':'synthetic'}}))
   events.insert(4,('candidate',{'kind':'handoff_committed','matched':0 if basis=='quiet_provider_traffic' else 3,'overlapMs':30000,'handoffs':1,'accessToken':'private-marker','basis':basis,'contentVerified':True}))
  if diagnostic is not None:events.insert(-1,('original',{'kind':'original_decode_error',**diagnostic}))
  tail=[('candidate',{'kind':'frame',**frame(108050)})] if drained_peer else []
  if before_ready:
   events=events[:2]+[('original',{'kind':'abort','reason':'original_socket_closed'})]
   tail=[('candidate',{'kind':'candidate_decode_error','code':'invalid_header','byteLength':14})]
  class Pipe:
   def write(self,*a):writes.extend(a)
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
   def emit(self,kind,**kw):evidence.append({'kind':kind,**kw})
  inspection={'HostConfig':{'ReadonlyRootfs':True,'Memory':268435456,'PidsLimit':32,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'NanoCpus':250000000},'Config':{'User':'65534:65534','Env':[]},'Mounts':[]}
  fake_process=types.SimpleNamespace(PIPE=-1,DEVNULL=-3,Popen=Process,run=lambda args,**kw:types.SimpleNamespace(returncode=1 if args[1]=='inspect' else 0),TimeoutExpired=TimeoutError)
  with patch.object(m,'time',types.SimpleNamespace(time=lambda:clock[0],monotonic=lambda:clock[0],sleep=lambda _:None)),patch.object(m,'pressure',return_value=False),patch.object(m,'subprocess',fake_process),patch.object(m,'queue',types.SimpleNamespace(Queue=Queue,Empty=queue.Empty)),patch.object(m,'command',side_effect=lambda args,**kw:json.dumps([inspection]) if '--format' not in args else 'synthetic-image'):
   result=m.session({'label':'test','workspaceId':'synthetic'},dict(monitor='',observer='',entry='',wsFiles={}),1000,Evidence())
   result['_evidence']=evidence
   result['_writes']=writes
   return result
 def test_replacement_uses_private_pipe_and_handoff_evidence_is_filtered(self):
  result=self.session_fixture(drained_peer=True,replacement=True)
  self.assertTrue(any('private-marker' in x for x in result.pop('_writes')))
  self.assertNotIn('private-marker',json.dumps(result))
  self.assertTrue(any(x['kind']=='handoff_committed' and x['matched']==3 for x in result['_evidence']))
 def test_quiet_basis_does_not_claim_content_verification_or_leak_unknown_reason(self):
  for basis in ['quiet_provider_traffic','content_matched','private-marker']:
   with self.subTest(basis=basis):
    result=self.session_fixture(drained_peer=True,replacement=True,basis=basis)
    record=next(x for x in result['_evidence'] if x['kind']=='handoff_committed')
    self.assertNotIn('private-marker',json.dumps(record))
    if basis=='private-marker':self.assertNotIn('basis',record)
    else:
     self.assertEqual(record['basis'],basis)
     self.assertEqual(record['contentVerified'],basis=='content_matched')
 def test_decode_diagnostic_preserves_only_safe_metadata(self):
  result=self.session_fixture(diagnostic={'opcode':2,'payloadChars':24,'byteLength':18,'code':'invalid_header','payload':'private-marker','requestId':'private-marker'})
  record=next(x for x in result['_evidence'] if x['kind']=='original_decode_error')
  self.assertEqual({k:record[k] for k in ['kind','opcode','payloadChars','byteLength','code']},{'kind':'original_decode_error','opcode':2,'payloadChars':24,'byteLength':18,'code':'invalid_header'})
  self.assertIsNone(record['serviceCode']);self.assertIsNone(record['headerValid'])
  self.assertNotIn('private-marker',json.dumps(result))
 def test_decode_diagnostic_rejects_untrusted_strings(self):
  result=self.session_fixture(diagnostic={'opcode':'private-marker','payloadChars':'private-marker','byteLength':True,'code':'private-marker'})
  record=next(x for x in result['_evidence'] if x['kind']=='original_decode_error')
  self.assertEqual(record['kind'],'original_decode_error');self.assertEqual(record['code'],'packet_decode_failed')
  self.assertTrue(all(v is None for k,v in record.items() if k not in ['kind','code']))
 def test_diagnostics_survive_shutdown_before_candidate_ready(self):
  result=self.session_fixture(before_ready=True)
  record=next(x for x in result['_evidence'] if x['kind']=='candidate_decode_error')
  self.assertEqual(record['code'],'invalid_header');self.assertEqual(record['byteLength'],14)
  self.assertFalse(result['ready'])
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
class IndependentTargetTests(unittest.TestCase):
 def run_campaign(self,label,state,result=None):
  records=[]
  class Evidence:
   def __init__(self,*a):pass
   def emit(self,kind,**values):records.append({'kind':kind,**values})
  class Stop:
   stopped=False
   def is_set(self):return self.stopped
   def wait(self,*a):self.stopped=True
   def set(self):self.stopped=True
  with patch.object(m,'STOP',Stop()),patch.object(m,'Evidence',Evidence),patch.object(m,'original_state',return_value=state) as original,patch.object(m,'session',return_value=result or {'reason':'campaign_complete','candidateRemoved':True}) as session:
   m.campaign({'label':label,'workspaceId':'synthetic-'+label},{},m.time.time()+300)
   return records,original.call_args_list,session.call_args_list
 def test_each_connected_target_starts_without_other_account_evidence(self):
  for label in ['observer-a','observer-b','test']:
   with self.subTest(label=label):
    records,lookups,sessions=self.run_campaign(label,{'state':'connected'})
    self.assertEqual(len(sessions),1)
    self.assertEqual(lookups[0].args,('synthetic-'+label,))
    self.assertFalse(any(x['kind']=='waiting_for_canary' for x in records))
 def test_offline_test_does_not_prevent_operating_targets(self):
  records,_,sessions=self.run_campaign('test',{'state':'waiting_for_live','lastErrorCode':'broadcast_offline'})
  self.assertEqual(len(sessions),0);self.assertTrue(any(x['kind']=='waiting' for x in records))
  for label in ['observer-a','observer-b']:
   self.assertEqual(len(self.run_campaign(label,{'state':'connected'})[2]),1)
 def test_target_mismatch_still_halts_without_retry(self):
  result={'reason':'event_mismatch','reviewRequired':True,'candidateRemoved':True}
  for label in ['observer-a','observer-b','test']:
   records,_,sessions=self.run_campaign(label,{'state':'connected'},result)
   self.assertEqual(len(sessions),1)
   self.assertTrue(any(x['kind']=='needs_review' for x in records))
   self.assertFalse(any(x['kind']=='campaign_finished' for x in records))
class UserDeclaredStopTests(unittest.TestCase):
 def test_unbounded_requires_explicit_policy_and_null_deadline(self):
  self.assertIsNone(m.campaign_deadline({'stopPolicy':'user_declared','endEpoch':None}))
  for config in [{},{'endEpoch':None},{'stopPolicy':'user_declared'},{'endEpoch':float('inf')}]:
   with self.assertRaises(RuntimeError):m.campaign_deadline(config)
 def test_finite_deadlines_remain_bounded(self):
  end=m.time.time()+1000
  self.assertEqual(m.campaign_deadline({'endEpoch':end}),end)
  for end in [m.time.time()-1,m.time.time()+200000]:
   with self.assertRaises(RuntimeError):m.campaign_deadline({'endEpoch':end})
 def test_manual_campaign_renews_bounded_session_and_preserves_review_stop(self):
  records=[];calls=[]
  class Evidence:
   def __init__(self,*a):pass
   def emit(self,kind,**values):records.append({'kind':kind,**values})
  class Stop:
   def is_set(self):return False
   def wait(self,*a):pass
   def set(self):pass
  def run(*args):
   calls.append(args[2])
   return {'reason':'campaign_complete' if len(calls)==1 else 'event_mismatch','candidateRemoved':True,'reviewRequired':len(calls)>1}
  with patch.object(m,'STOP',Stop()),patch.object(m,'Evidence',Evidence),patch.object(m,'original_state',return_value={'state':'connected'}),patch.object(m,'session',side_effect=run),patch.object(m.time,'time',return_value=1000):
   m.campaign({'label':'test','workspaceId':'synthetic'},{},None)
  self.assertEqual(calls,[173800,173800])
  self.assertEqual(records[0]['stopPolicy'],'user_declared');self.assertIsNone(records[0]['deadline'])
  self.assertTrue(any(x['kind']=='renewal_gap' for x in records))
  self.assertTrue(any(x['kind']=='needs_review' for x in records))
  self.assertFalse(any(x['kind']=='campaign_finished' for x in records))
 def test_explicit_stop_exits_manual_campaign(self):
  records=[]
  class Evidence:
   def __init__(self,*a):pass
   def emit(self,kind,**values):records.append(kind)
  with patch.object(m,'Evidence',Evidence),patch.object(m.STOP,'is_set',return_value=True),patch.object(m,'session') as session:
   m.campaign({'label':'test'},{},None)
  session.assert_not_called();self.assertIn('campaign_finished',records)

class BroadcastLifecycleTests(unittest.TestCase):
 def test_stale_original_heartbeat_cannot_prove_broadcast_end(self):
  workspace='synthetic';tag=m.hashlib.sha256(workspace.encode()).hexdigest()[:12]
  state={'heartbeatAt':'1970-01-01T00:01:40Z','channels':[{'workspace':tag,'state':'waiting_for_live','lastErrorCode':'broadcast_offline'}],'queue':{'pending':0,'deadLetters':0}}
  with patch.object(m,'command',return_value=json.dumps(state)),patch.object(m.time,'time',return_value=200):
   self.assertEqual(m.original_state(workspace)['lastErrorCode'],'original_state_stale')
   self.assertIsNone(m.original_state(workspace)['state'])
 def fixture(self,reason='original_broadcast_closed',offline_after=25,review=False):
  records=[];calls=[];clock=[0];lookups=[0]
  class Evidence:
   def __init__(self,*a):pass
   def emit(self,kind,**values):records.append({'kind':kind,**values})
  class Stop:
   def is_set(self):return False
   def wait(self,seconds):clock[0]+=seconds
  def state(_):
   lookups[0]+=1
   if len(calls)==1 and clock[0]>=offline_after and lookups[0]<100:return {'state':'waiting_for_live','lastErrorCode':'broadcast_offline'}
   return {'state':'connected','lastErrorCode':None}
  # After independent offline confirmation, the next original connection is a
  # new broadcast. A second session stops the fixture without another loop.
  def offline(target,evidence):
   result=original_confirm(target,evidence)
   if result:lookups[0]=100
   return result
  def session(*a):
   calls.append(a)
   return {'reason':reason if len(calls)==1 else 'supervisor_stopped','candidateRemoved':True,'reviewRequired':review}
  original_confirm=m.confirm_broadcast_offline
  with patch.object(m,'STOP',Stop()),patch.object(m,'Evidence',Evidence),patch.object(m,'original_state',side_effect=state),patch.object(m,'session',side_effect=session),patch.object(m,'confirm_broadcast_offline',side_effect=offline),patch.object(m.time,'monotonic',side_effect=lambda:clock[0]):
   m.campaign({'label':'test','workspaceId':'synthetic'},{},None)
  return records,calls,clock[0]
 def test_delayed_original_offline_after_close_resumes_next_broadcast(self):
  for reason in ['original_broadcast_closed','broadcast_closed','original_socket_closed','socket_closed','original_state_changed','auth_rejected']:
   with self.subTest(reason=reason):
    records,calls,seconds=self.fixture(reason)
    self.assertEqual(len(calls),2);self.assertGreaterEqual(seconds,25)
    self.assertTrue(any(r['kind']=='broadcast_ended' for r in records))
    self.assertFalse(any(r['kind']=='needs_review' for r in records))
 def test_no_offline_confirmation_still_stops(self):
  records,calls,_=self.fixture(offline_after=1000)
  self.assertEqual(len(calls),1);self.assertTrue(any(r['kind']=='needs_review' for r in records))
 def test_bad_packet_and_mismatch_are_never_relabelled_as_offline(self):
  for reason,review in [('invalid_packet_size',False),('original_packet_decode_failed',False),('event_mismatch',True),('comparison_incomplete',True),('join_owner_mismatch',False)]:
   records,calls,_=self.fixture(reason,offline_after=0,review=review)
   self.assertEqual(len(calls),1);self.assertTrue(any(r['kind']=='needs_review' and r['reason']==reason for r in records))
   self.assertFalse(any(r['kind']=='broadcast_ended' for r in records))
 def test_header_metadata_is_bounded_and_does_not_include_raw_fields(self):
  d=m.safe_packet_diagnostic({'byteLength':14,'packetOffset':0,'headerValid':True,'serviceCode':88,'declaredLength':0,'retCode':0,'remainingBodyBytes':0,'payload':'private','accessToken':'private','code':'private'})
  self.assertEqual(d['serviceCode'],88);self.assertEqual(d['declaredLength'],0);self.assertEqual(d['code'],'packet_decode_failed');self.assertNotIn('private',json.dumps(d))
  for value in [-1,True,'private',1000001]:self.assertIsNone(m.safe_packet_diagnostic({'byteLength':value})['byteLength'])

if __name__=='__main__':unittest.main()
