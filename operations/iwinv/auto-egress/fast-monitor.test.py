import ast
import datetime
import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fast = load('fast', 'patch-fast-monitor.py')
slow = load('slow', 'patch-monitor.py')
SOURCE = pathlib.Path(sys.argv.pop()).read_text(encoding='utf8') if len(sys.argv)>1 else None


class FastTests(unittest.TestCase):
    def test_same_source_is_same_observation_across_timers(self):
        for now in (1000, 1010, 1030):
            self.assertEqual(fast.auto_egress_observation({'observedAt':1000}, now), 1000)

    def test_missing_and_old_healthy_samples_cannot_recover(self):
        for value in (None, {}, {'observedAt':1}, {'observedAt':True}, {'observedAt':2000}):
            self.assertIsNone(fast.auto_egress_observation(value,1000))

    def test_stale_failure_advances_only_per_thirty_second_bucket(self):
        self.assertEqual(fast.auto_egress_observation({'error':'controller_stale'},1000),
                         fast.auto_egress_observation({'error':'controller_stale'},1010))
        self.assertNotEqual(fast.auto_egress_observation({'error':'controller_stale'},1000),
                            fast.auto_egress_observation({'error':'controller_stale'},1030))

    def test_disabled_mode_does_not_read_config_or_connect(self):
        with patch.object(pathlib.Path,'exists',return_value=False):
            self.assertEqual(fast.monitor_auto_egress_only('unused',1000),{'ok':True,'disabled':True})

    @unittest.skipUnless(SOURCE,'requires installed source fixture')
    def test_live_source_patched_flow_without_network(self):
        source = fast.patch(SOURCE)
        with self.assertRaises(ValueError):fast.patch(source)
        with self.assertRaises(ValueError):fast.patch(SOURCE.replace('for key in LABELS:', 'for key in DRIFT:'))
        wanted={'capture_auto_egress','auto_egress_detail','capture_connection_detail','connection_alert_detail',
                'auto_egress_observation','monitor_auto_egress_only','advance_alerts','deliver','connect','get','put','atomic'}
        nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name in wanted]
        calls=[]
        def sender(url,body,headers):
            calls.append((url,body))
            return 200,{'channel_id':'fixture'},0
        scope={'pathlib':pathlib,'sqlite3':sqlite3,'json':json,'datetime':datetime,'request':sender,
               'CHANNEL':'fixture','LABELS':{'auto_egress':'controller','unrelated':'untouched'},
               'HEALTH_KEYS':set(),'WARNING_KEYS':set(),'stamp':lambda value:0}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'candidate','exec'),scope)
        state={}
        def advance(at,now,bad):
            detail=scope['capture_auto_egress']({'at':at,'lastError':'api_http_401' if bad else None},now)
            scope['advance_alerts'](state,{'auto_egress'} if bad else set(),now,{'autoEgress':detail},only={'auto_egress'})
        advance(1000,1000,True);advance(1000,1010,True)
        self.assertFalse(state['auto_egress']['open'])
        advance(1030,1030,True)
        scope['deliver'](state,'https://invalid.test',1030)
        advance(1060,1060,False);advance(1060,1070,False)
        self.assertTrue(state['auto_egress']['open'])
        advance(1090,1090,False)
        scope['deliver'](state,'https://invalid.test',1090)
        self.assertEqual(len(calls),2)
        self.assertNotIn('unrelated',state)
        # A failed recovery delivery must not be retried after failure returns.
        state['auto_egress']['pending']={'open':False,'due':2000}
        advance(1120,1120,True)
        self.assertIsNone(state['auto_egress']['pending'])
        self.assertTrue(state['auto_egress']['open'])
        with tempfile.TemporaryDirectory() as tmp:
            scope['ROOT']=pathlib.Path(tmp)
            db=scope['connect'](pathlib.Path(tmp)/'metrics.sqlite3')
            unrelated={'open':True,'bad':7,'good':0,'pending':None}
            scope['put'](db,'alerts',{'unrelated':unrelated});db.commit();db.close()
            for now in (1000,1030,200000):
                scope['read_json']=lambda path:{'at':now,'lastError':None,'private':'secret'}
                with patch.object(pathlib.Path,'exists',return_value=True):
                    result=scope['monitor_auto_egress_only']('https://invalid.test',now)
                self.assertEqual(result['notifications']['sent'],0)
                self.assertNotIn('private',json.dumps(result))
            db=sqlite3.connect(pathlib.Path(tmp)/'metrics.sqlite3')
            saved=scope['get'](db,'alerts')
            self.assertEqual(saved['unrelated'],unrelated)
            self.assertEqual(db.execute('select count(*) from auto_egress_samples').fetchone()[0],1)
            self.assertEqual(db.execute('select count(*) from samples').fetchone()[0],0)
            db.close()
            self.assertEqual(len(calls),2)  # No DB/website/provider calls in fast path.


if __name__=='__main__':unittest.main()
