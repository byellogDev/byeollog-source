import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('channel_health', pathlib.Path(__file__).with_name('channel_health.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

def channel(state, error=None, tag='fixture'):
    return {'workspace': tag, 'state': state, 'lastErrorCode': error}

def observe(channels, previous=None, now=100, fresh=True):
    return policy.assess_channels(channels, previous or {}, now, fresh=fresh)

class ChannelHealthTests(unittest.TestCase):
    def test_failure_connecting_does_not_recover(self):
        state, report = observe([channel('retry_wait', 'ready_timeout')])
        for tick in (130, 160, 500):
            state, report = observe([channel('connecting', 'ready_timeout')], state, tick)
            self.assertEqual(report['channelErrors'], 1)
            self.assertFalse(report['channelRecoveryConfirmed'])

    def test_failure_survives_missing_error_and_restart(self):
        state, _ = observe([channel('retry_wait', 'ready_timeout')])
        state, report = observe([channel('connecting')], state, 130)
        self.assertEqual(report['channelErrors'], 1)
        _, report = observe([channel('connecting', 'ready_timeout')], {}, 200)
        self.assertEqual(report['channelErrors'], 1)

    def test_connected_clears_only_with_fresh_proof(self):
        state, _ = observe([channel('retry_wait', 'ready_timeout')])
        next_state, report = observe([channel('connected')], state, 130, fresh=False)
        self.assertFalse(report['channelRecoveryConfirmed'])
        self.assertEqual(next_state, state)
        _, report = observe([channel('connected')], state, 160)
        self.assertEqual(report['channelErrors'], 0)
        self.assertTrue(report['channelRecoveryConfirmed'])

    def test_confirmed_offline_is_safe(self):
        state, _ = observe([channel('retry_wait', 'ready_timeout')])
        state, report = observe([channel('waiting_for_live', 'broadcast_offline')], state, 130)
        self.assertTrue(report['channelRecoveryConfirmed'])
        _, report = observe([channel('connecting', 'broadcast_offline')], state, 140)
        self.assertEqual(report['channelErrors'], 0)
        self.assertFalse(report['channelRecoveryConfirmed'])

    def test_new_connection_and_idle_have_bounded_grace(self):
        for value in ('connecting', 'idle'):
            state, report = observe([channel(value)])
            self.assertFalse(report['channelRecoveryConfirmed'])
            self.assertEqual(report['channelErrors'], 0)
            _, report = observe([channel(value)], state, 191)
            self.assertEqual(report['channelErrors'], 1)

    def test_other_channel_cannot_mask_failed_channel(self):
        _, report = observe([channel('connected', tag='good'), channel('connecting', 'ready_timeout', 'bad')])
        self.assertEqual(report['channelErrors'], 1)
        self.assertFalse(report['channelRecoveryConfirmed'])

    def test_disappeared_failure_is_not_recovery(self):
        state, _ = observe([channel('retry_wait', 'ready_timeout')])
        _, report = observe([], state, 160)
        self.assertFalse(report['channelRecoveryConfirmed'])
        self.assertEqual(report['channelErrors'], 1)

    def test_missing_duplicate_and_invalid_telemetry(self):
        for rows in (None, {}, [None], [channel('connected'), channel('connected')]):
            _, report = observe(rows)
            self.assertGreater(report['channelErrors'], 0)
            self.assertFalse(report['channelRecoveryConfirmed'])

    def test_socket_port_inventory_without_personal_data(self):
        raw='ESTAB 0 0 172.18.0.2:50000 8.8.8.8:9001\nSYN-SENT 0 1 172.18.0.2:50001 8.8.4.4:9041\nESTAB 0 0 127.0.0.1:4 127.0.0.1:12345'
        report=policy.assess_ports(raw, [53,80,443,8041,9001], [])
        self.assertEqual(report['unapprovedEgressPorts'], [9041])
        self.assertEqual(report['synSentPorts'], [9041])
        self.assertNotIn('8.8', str(report))
        self.assertEqual(policy.assess_ports('', [9001], [9041])['unapprovedEgressPorts'], [9041])
        self.assertEqual(policy.assess_ports('', [9001,9041], [9041])['unapprovedEgressPorts'], [])

if __name__ == '__main__':
    unittest.main()
