import importlib.util,pathlib,tempfile,unittest,json,sys,types
from unittest.mock import patch
try:import fcntl
except ImportError:
    # Windows unit tests only. Linux verification uses real flock.
    sys.modules['fcntl']=types.SimpleNamespace(flock=lambda *a:None,LOCK_EX=1,LOCK_NB=2)
ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'operations/ncp'/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
retry=load('retry','upbo-retry-runner.py');retention=load('retention','backup-retention.py')
class UsageTests(unittest.TestCase):
    def test_partial_failure_resumes_only_unfinished_and_modified_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)/'backups';root.mkdir();(root/'progress.json').write_text('{"completed":{}}')
            cfg=pathlib.Path(tmp)/'config';cfg.write_text('{}');calls=[];failed=[True];versions={'a':'v1','b':'v1'}
            def request(opener,config,mode,body=None,metrics=None):
                if mode=='retention-list':return {'items':[{'name':k,'updated_at':v} for k,v in versions.items()]}
                name=body['path'];calls.append(name)
                if name=='b' and failed[0]:raise TimeoutError()
                return {'path':name,'changed':False,'removedTiles':0,'removedBroadcasts':0,'checkpoint':{'version':1,'sourceVersion':versions[name],'nextReviewAt':2000000}}
            def atomic(path,value):path.write_text(json.dumps(value))
            with patch.object(retention,'ROOT',root),patch.object(retention,'CONFIG',cfg),patch.object(retention,'request',request),patch.object(retention,'atomic',atomic),patch.object(retention.time,'time',return_value=1000):
                self.assertEqual(retention.main(),1);self.assertEqual(calls,['a','b'])
                failed[0]=False;calls.clear();self.assertEqual(retention.main(),0);self.assertEqual(calls,['b'])
                versions['a']='v2';calls.clear();self.assertEqual(retention.main(),0);self.assertEqual(calls,['a'])
    def test_empty_backoff_is_bounded(self):
        state={};delays=[]
        for i in range(8):state=retry.next_state(state,{'claimed':0},i*300);delays.append(state['delaySeconds'])
        self.assertEqual(delays,[60,120,240,300,300,300,300,300])
    def test_work_restores_fast_poll(self):
        self.assertEqual(retry.next_state({'empty':4},{'claimed':1},0)['delaySeconds'],60)
    def test_clock_rollback_and_bad_deadline_poll_now(self):
        self.assertTrue(retry.due({'version':1,'at':100,'nextAt':400},99));self.assertTrue(retry.due({'version':1,'at':0,'nextAt':99999},1))
    def test_empty_skips_network_then_due_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            clock=[0];calls=[];req=lambda:(calls.append(1) or {'claimed':0,'failed':0})
            retry.run(pathlib.Path(tmp),req,lambda:clock[0]);clock[0]=30
            self.assertTrue(retry.run(pathlib.Path(tmp),req,lambda:clock[0])['skipped']);self.assertEqual(len(calls),1)
            clock[0]=60;retry.run(pathlib.Path(tmp),req,lambda:clock[0]);self.assertEqual(len(calls),2)
    def test_error_clears_backoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp);retry.run(path,lambda:{'claimed':0},lambda:0)
            with self.assertRaises(ValueError):retry.run(path,lambda:{'paused':True},lambda:60)
            self.assertFalse((path/'state.json').exists())
    def test_bad_state_recovers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp);(path/'state.json').write_text('{')
            self.assertEqual(retry.run(path,lambda:{'claimed':1},lambda:0)['claimed'],1)
    def test_checkpoint_version_expiry_and_mirror_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            retention.ROOT=pathlib.Path(tmp);p=retention.ROOT/'mirror';p.write_text('same')
            item={'updated_at':'v1'};result={'changed':False,'checkpoint':{'version':1,'sourceVersion':'v1','nextReviewAt':1000}}
            saved=retention.make_checkpoint(result,item,[p],0)
            self.assertTrue(retention.checkpoint_valid(saved,item,[p],999))
            self.assertFalse(retention.checkpoint_valid(saved,item,[p],1000))
            self.assertFalse(retention.checkpoint_valid(saved,{'updated_at':'v2'},[p],1))
            p.write_text('changed');self.assertFalse(retention.checkpoint_valid(saved,item,[p],1))
    def test_missing_metadata_or_changed_archive_cannot_skip(self):
        self.assertIsNone(retention.make_checkpoint({'changed':True},{},[],0))
        self.assertFalse(retention.checkpoint_valid({'version':1},{},[],0))
    def test_new_mirror_forces_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            retention.ROOT=pathlib.Path(tmp);p=retention.ROOT/'new';p.write_text('new')
            saved={'version':1,'sourceVersion':'v','checkedAt':0,'nextReviewAt':1000,'mirrors':{}}
            self.assertFalse(retention.checkpoint_valid(saved,{'updated_at':'v'},[p],1))
if __name__=='__main__':unittest.main()
