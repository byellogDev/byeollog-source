import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('promotion',pathlib.Path(__file__).with_name('promote-host.py'))
promotion=importlib.util.module_from_spec(spec);spec.loader.exec_module(promotion)

class ReadinessTests(unittest.TestCase):
    def test_health_does_not_certify_uninitialized_accounts(self):
        healthy={'State':{'Health':{'Status':'healthy'}}}
        worker={'heartbeatAt':'2026-10-15T00:00:01Z','channels':[]}
        self.assertFalse(promotion.collector_ready(healthy,worker,['fixture'],0))
        worker['channels']=[{'workspace':'fixture','state':'starting'}]
        self.assertFalse(promotion.collector_ready(healthy,worker,['fixture'],0))
        worker['channels'][0].update(state='waiting_for_live',lastErrorCode='broadcast_offline')
        self.assertTrue(promotion.collector_ready(healthy,worker,['fixture'],0))
    def test_old_heartbeat_or_wrong_account_cannot_pass(self):
        healthy={'State':{'Health':{'Status':'healthy'}}}
        worker={'heartbeatAt':'2026-10-15T00:00:01Z','channels':[{'workspace':'fixture','state':'connected'}]}
        self.assertFalse(promotion.collector_ready(healthy,worker,['other'],0))
        self.assertFalse(promotion.collector_ready(healthy,worker,['fixture'],9999999999))

if __name__=='__main__':unittest.main()
