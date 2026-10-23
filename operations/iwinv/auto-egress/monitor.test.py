import ast
import datetime
import importlib.util
import pathlib
import sys
import unittest

spec=importlib.util.spec_from_file_location('patch',pathlib.Path(__file__).with_name('patch-monitor.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE=pathlib.Path(sys.argv.pop()).read_text(encoding='utf8') if len(sys.argv)>1 else None

class MonitorTests(unittest.TestCase):
    def test_stale_is_error_not_recovery(self):
        self.assertEqual(module.capture_auto_egress({'at':1},1000)['error'],'controller_stale')
    def test_secrets_and_arbitrary_text_never_render(self):
        safe=module.capture_auto_egress({'at':1000,'lastError':'private-token @everyone','ownedCount':'private-name'},1000)
        self.assertEqual(safe['error'],'controller_error')
        self.assertNotIn('private',module.auto_egress_detail(True,safe))
        self.assertIsNone(safe['ownedCount'])
    def test_recovery_does_not_claim_channel_recovery(self):
        self.assertIn('별도 확인',module.auto_egress_detail(False,{}))
    def test_provider_server_errors_are_not_controller_or_auth_errors(self):
        for status in (500, 502, 503, 504):
            code='api_http_'+str(status)
            detail=module.capture_auto_egress({'at':1000,'lastError':code},1000)
            self.assertEqual(detail['error'],code)
            message=module.auto_egress_detail(True,detail)
            self.assertIn('HTTP '+str(status),message)
            self.assertNotIn('API 인증 실패',message)
    def test_transport_failure_is_safe_fresh_and_specific(self):
        value={'at':1000,'lastError':'api_unavailable','lastApi':{'at':999,'outcome':'api_unavailable',
               'failureKind':'timeout','phase':'connect','elapsedMs':8001,'secret':'private-secret'}}
        detail=module.capture_auto_egress(value,1000)
        message=module.auto_egress_detail(True,detail)
        self.assertIn('API 응답 시간 초과',message)
        self.assertIn('8.0초',message)
        self.assertNotIn('private',str(detail))
        value['lastApi']['at']=1
        self.assertIsNone(module.capture_auto_egress(value,1000)['apiFailure'])
        value['lastApi']['at']=999;value['lastApi']['failureKind']='@everyone'
        self.assertIsNone(module.capture_auto_egress(value,1000)['apiFailure'])
    def test_logging_failure_does_not_silently_look_healthy(self):
        detail=module.capture_auto_egress({'at':1000,'diagnosticsHealthy':False},1000)
        self.assertEqual(detail['error'],'diagnostics_unavailable')
        self.assertIn('로그 저장 실패',module.auto_egress_detail(True,detail))
    @unittest.skipUnless(SOURCE,'requires installed source fixture')
    def test_actual_patched_pipeline_uses_mock_discord(self):
        patched=module.patch(SOURCE)
        wanted={'capture_auto_egress','auto_egress_detail','capture_connection_detail','connection_alert_detail','advance_alerts','deliver'}
        nodes=[n for n in ast.parse(patched).body if isinstance(n,ast.FunctionDef) and n.name in wanted]
        scope={'datetime':datetime,'CHANNEL':'fixture','request':None,'stamp':lambda x:float(x or 0),
               'LABELS':{'auto_egress':'SOOP 자동 출발 통신 제어 이상'},'HEALTH_KEYS':set(),'WARNING_KEYS':set()}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'isolated-monitor','exec'),scope)
        state={}
        for tick in (1000,1030):scope['advance_alerts'](state,{'auto_egress'},tick,{'autoEgress':{'error':'api_http_403'}})
        sent=[]
        def sender(url,body,headers):sent.append(body);return 200,{'channel_id':'fixture'},0
        scope['deliver'](state,'https://invalid.test',1030,sender)
        self.assertEqual(len(sent),1)
        self.assertIn('API 권한 또는 호출 IP 제한',sent[0]['content'])
        self.assertEqual(sent[0]['allowed_mentions'],{'parse':[]})
        with self.assertRaises(ValueError):module.patch(patched)

if __name__=='__main__':unittest.main()
