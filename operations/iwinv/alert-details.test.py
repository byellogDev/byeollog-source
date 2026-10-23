import ast
import datetime
import importlib.util
import pathlib
import sys
import unittest

spec=importlib.util.spec_from_file_location('details',pathlib.Path(__file__).with_name('patch-alert-details.py'))
details=importlib.util.module_from_spec(spec);spec.loader.exec_module(details)
SOURCE=pathlib.Path(sys.argv.pop()).read_text(encoding='utf8') if len(sys.argv)>1 and pathlib.Path(sys.argv[-1]).is_file() else None

class DetailTests(unittest.TestCase):
    def test_port_evidence_and_action_without_false_certainty(self):
        text=details.connection_alert_detail('egress_policy',True,{'ports':[9041]})
        for value in ('TCP 9041','추가 확인','목적지·포트만','재연결'):self.assertIn(value,text)

    def test_unrelated_connection_error_does_not_claim_port_block(self):
        text=details.connection_alert_detail('channel_state',True,{'reasons':['connection_not_ready'],'errors':1})
        self.assertIn('오류 채널: 1개',text);self.assertIn('포트 차단으로 단정할 수 없습니다',text)

    def test_shared_port_does_not_attribute_to_specific_channel(self):
        text=details.connection_alert_detail('channel_state',True,{'ports':[9041]})
        self.assertIn('직접 원인인지는 미확정',text)

    def test_state_recovery_is_distinct_from_rule_recovery(self):
        text=details.connection_alert_detail('egress_policy',False,{})
        self.assertIn('별도 확인',text)
        self.assertIn('두 건',details.connection_alert_detail('channel_state',False,{}))

    def test_private_strings_mentions_and_invalid_ports_are_excluded(self):
        raw={'unapprovedEgressPorts':['@everyone',True,-1,65536,9041,9041],
             'channelHealthReasons':['secret-token','https://private','worker_stale'],'channelErrors':'private-name'}
        safe=details.capture_connection_detail(raw)
        self.assertEqual(safe,{'ports':[9041],'reasons':['worker_stale'],'errors':None})
        text=details.connection_alert_detail('channel_state',True,safe)
        for value in ('secret-token','@everyone','https://private','private-name'):self.assertNotIn(value,text)

    def test_large_port_list_stays_bounded(self):
        text=details.connection_alert_detail('egress_policy',True,{'ports':list(range(1,65536))})
        self.assertLess(len(text),1000)

    def test_other_alerts_unchanged_and_observation_failure_is_unknown(self):
        self.assertEqual(details.connection_alert_detail('disk',True,{}),'')
        self.assertIn('판정할 수 없습니다',details.connection_alert_detail('egress_observation',True,{}))

    @unittest.skipUnless(SOURCE,'requires installed source for isolated sender test')
    def test_actual_monitor_pipeline_and_mock_discord_sender(self):
        patched=details.patch(SOURCE)
        tree=ast.parse(patched)
        wanted={'capture_connection_detail','connection_alert_detail','advance_alerts','deliver'}
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in wanted]
        scope={'datetime':datetime,'CHANNEL':'fixture','request':None,'stamp':lambda v:float(v or 0),
               'LABELS':{'egress_policy':'미허용 출발 포트 발견','channel_state':'수집 채널 상태 이상'},
               'HEALTH_KEYS':{'channel_state','egress_policy'},'WARNING_KEYS':set()}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'isolated-monitor','exec'),scope)
        state={}
        for tick in (2000,2030):
            scope['advance_alerts'](state,{'egress_policy','channel_state'},tick,
                {'healthAt':tick,'channelRecoveryConfirmed':False,'channelErrors':1,'channelHealthReasons':['connection_not_ready'],
                 'unapprovedEgressPorts':[9041],'healthWarnings':['channel_state','egress_policy']})
        messages=[]
        def sender(url,body,headers):
            messages.append(body);return 200,{'channel_id':'fixture'},0
        result=scope['deliver'](state,'https://invalid.test',2030,sender)
        self.assertEqual(result['sent'],2)
        self.assertTrue(any('대상 포트: TCP 9041' in m['content'] for m in messages))
        self.assertTrue(all(m['allowed_mentions']=={'parse':[]} for m in messages))
        self.assertTrue(all(len(m['content'])<2000 for m in messages))
        with self.assertRaises(ValueError):details.patch(patched)
        with self.assertRaises(ValueError):details.patch('changed source')

if __name__=='__main__':unittest.main()
