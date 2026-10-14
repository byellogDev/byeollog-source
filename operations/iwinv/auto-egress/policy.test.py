import copy
import hashlib
import hmac
import json
import io
import tempfile
import unittest
from pathlib import Path
from iwinv_api import ApiError, FirewallApi, signature
from policy import Engine, endpoint, digest

BASE = [{'rule_id': 1, 'bound': 'OUT', 'protocol': 'TCP', 'port': '443', 'ip': '0.0.0.0/0'},
        {'rule_id': 2, 'bound': 'IN', 'protocol': 'TCP', 'port': '22', 'ip': '8.8.8.8/32'}]

class FakeApi:
    def __init__(self): self.rows, self.posts, self.deletes = copy.deepcopy(BASE), 0, []
    def rules(self): return copy.deepcopy(self.rows)
    def create(self, ip, port, title):
        self.posts += 1
        self.rows.append({'rule_id': 100+self.posts, 'bound': 'OUT', 'protocol': 'TCP', 'port': str(port),
                          'ip': ip+'/32', 'title': title, 'content': 'SOOP verified outbound'})
    def delete_owned(self, rid):
        self.deletes.append(rid)
        self.rows = [r for r in self.rows if str(r['rule_id']) != rid]

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'state.json'
        self.api, self.now = FakeApi(), 10000
        self.engine = Engine(self.api, self.path, BASE, clock=lambda:self.now)
    def test_signing_contract(self):
        expected = hmac.new(b'fake-secret', b'1720000000/v1/security-groups/42/rules', hashlib.sha256).hexdigest()
        self.assertEqual(signature('fake-secret',1720000000,'/v1/security-groups/42/rules'),expected)
        for path in ['/v1/security-groups/42/', '/v1/a?x=1','https://example.com']:
            with self.assertRaises(ApiError): signature('test',1,path)
    def test_client_cannot_manage_instances_or_other_group(self):
        api=FirewallApi('fake','fake','42')
        for method, path in [('POST','/instances'),('GET','/../43/rules'),('DELETE',''),('PUT','/rules')]:
            with self.assertRaisesRegex(ApiError,'operation_denied'):api.request(method,path)
        for bound,ip in [('inbound','8.8.8.8/32'),('outbound','0.0.0.0/0')]:
            with self.assertRaisesRegex(ApiError,'mutation_denied'):
                api.request('POST','/rules',{'bound':bound,'protocol':'tcp','port':'8041','ip':ip,'title':'blg-auto-'+'a'*16,'content':'SOOP verified outbound'})
    def test_rejects_private_and_low_ports(self):
        api=FirewallApi('fake','fake','42')
        for ip,port in [('127.0.0.1',8041),('169.254.169.254',8041),('10.1.2.3',8041),('8.8.8.8',22),('8.8.8.8',True)]:
            with self.assertRaises(ApiError):api.create(ip,port,'blg-auto-'+'a'*16)
    def test_api_authentication_and_complete_inventory(self):
        calls=[]
        class Opener:
            def open(self,request,timeout):
                calls.append(request)
                return io.BytesIO(json.dumps({'code':'0x00','error_code':'SUCCESS','count':len(BASE),'result':BASE}).encode())
        api=FirewallApi('fake-access','fake-secret','42',opener=Opener(),clock=lambda:1720000000,sleep=lambda _:None)
        self.assertEqual(api.rules(),BASE)
        self.assertEqual(calls[0].full_url,'https://api-kr.iwinv.kr/v1/security-groups/42/rules')
        headers={k.lower():v for k,v in calls[0].header_items()}
        self.assertEqual(headers['x-iwinv-signature'],signature('fake-secret',1720000000,'/v1/security-groups/42/rules'))
        class Incomplete:
            def open(self,*args,**kwargs):return io.BytesIO(b'{"code":"0x00","error_code":"SUCCESS","count":100,"result":[]}')
        api.opener=Incomplete()
        with self.assertRaisesRegex(ApiError,'rules_incomplete'):api.rules()
    def test_provider_identity_and_dns(self):
        payload={'result':1,'data':[{'id':'fixture','chat_ip':'110.10.76.111','chat_port':8040,'chat_no':123,'key':'fixture-key'}]}
        self.assertEqual(endpoint(payload,'fixture',lambda host:['110.10.76.111']),('110.10.76.111',8041))
        with self.assertRaisesRegex(ApiError,'owner_mismatch'):endpoint(payload,'other',lambda host:[])
        with self.assertRaisesRegex(ApiError,'dns_mismatch'):endpoint(payload,'fixture',lambda host:['8.8.8.8'])
        self.assertIsNone(endpoint({'result':-1302},'fixture',lambda host: self.fail('offline DNS query')))
    def test_provider_create_requires_uppercase_enums(self):
        class Opener:
            def open(inner,request,timeout):
                body=json.loads(request.data)
                self.assertEqual(body['bound'],'OUT')
                self.assertEqual(body['protocol'],'TCP')
                return io.BytesIO(b'{"code":"0x00","error_code":"SUCCESS"}')
        api=FirewallApi('fake','fake','42',opener=Opener())
        api.create('110.10.76.111',8041,'blg-auto-'+'a'*16)
    def test_manual_baseline_does_not_create(self):
        self.assertEqual(self.engine.ensure('110.10.76.111',443),'baseline')
        self.assertEqual(self.api.posts,0)
    def test_create_readback_and_restart_idempotency(self):
        self.assertEqual(self.engine.ensure('110.10.76.111',8041),'created')
        self.engine=Engine(self.api,self.path,BASE,clock=lambda:self.now)
        self.assertEqual(self.engine.ensure('110.10.76.111',8041),'existing')
        self.assertEqual(self.api.posts,1)
    def test_lost_post_response_adopts_only_exact_owned_rule(self):
        original=self.api.create
        def lost(*args):original(*args);raise ApiError('api_unavailable')
        self.api.create=lost
        self.assertEqual(self.engine.ensure('110.10.76.111',8041),'created')
        self.assertEqual(self.api.posts,1)
    def test_uncertain_missing_create_never_reposts(self):
        def lost(*args):self.api.posts+=1;raise ApiError('api_unavailable')
        self.api.create=lost
        for attempt in range(3):
            with self.assertRaisesRegex(ApiError,'create_outcome_unknown'):self.engine.ensure('110.10.76.111',8041)
            self.engine=Engine(self.api,self.path,BASE,clock=lambda:self.now)
        self.assertEqual(self.api.posts,1)
    def test_baseline_drift_freezes_before_mutation(self):
        self.api.rows[1]['ip']='0.0.0.0/0'
        with self.assertRaisesRegex(ApiError,'baseline_drift'):self.engine.ensure('110.10.76.111',8041)
        self.assertEqual(self.api.posts,0)
        self.assertEqual(self.engine.state['frozen'],'baseline_drift')
    def test_unknown_rule_freezes(self):
        self.api.rows.append({'rule_id':9,'bound':'OUT','protocol':'TCP','port':'9001','ip':'0.0.0.0/0'})
        with self.assertRaisesRegex(ApiError,'unreviewed_rule_drift'):self.engine.ensure('110.10.76.111',8041)
    def test_capacity_and_rate_limit(self):
        self.engine.max_rules=1
        self.engine.ensure('110.10.76.111',8041)
        with self.assertRaisesRegex(ApiError,'rule_capacity'):self.engine.ensure('110.10.76.112',8041)
        self.engine.max_rules=24
        self.engine.state['created']=[self.now]*6
        with self.assertRaisesRegex(ApiError,'creation_rate_limit'):self.engine.ensure('110.10.76.112',8041)
    def test_cleanup_preserves_active_and_baseline(self):
        self.engine.ensure('110.10.76.111',8041)
        self.now+=1000
        self.engine.cleanup({'ok':True,'at':self.now,'active':[digest('110.10.76.111',8041)]})
        self.assertFalse(self.api.deletes)
        self.now+=1000
        self.engine.cleanup({'ok':True,'at':self.now,'active':[]})
        self.assertEqual(self.api.deletes,['101'])
        self.assertEqual(self.api.rows,BASE)
        self.assertEqual(self.engine.state['owned'],[])
    def test_stale_observation_never_deletes(self):
        self.engine.ensure('110.10.76.111',8041)
        self.now+=1000
        with self.assertRaisesRegex(ApiError,'observation_stale'):self.engine.cleanup({'ok':True,'at':1,'active':[]})
        self.assertFalse(self.api.deletes)
    def test_modified_owned_rule_never_deleted(self):
        self.engine.ensure('110.10.76.111',8041)
        self.api.rows[-1]['ip']='0.0.0.0/0'
        self.now+=1000
        with self.assertRaisesRegex(ApiError,'owned_rule_drift'):self.engine.cleanup({'ok':True,'at':self.now,'active':[]})
        self.assertFalse(self.api.deletes)

if __name__=='__main__':unittest.main()
