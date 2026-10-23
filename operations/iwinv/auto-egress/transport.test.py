import http.client
import io
import json
import socket
import ssl
import unittest
import urllib.error

from iwinv_api import ApiError, FirewallApi


class TransportTests(unittest.TestCase):
    def check_failure(self, opener, kind, phase, method='GET', suffix='/instances', body=None):
        api = FirewallApi('private-access', 'private-secret', '42', opener=opener)
        with self.assertLogs('iwinv_api', level='WARNING') as captured:
            with self.assertRaisesRegex(ApiError, '^api_unavailable$'):
                api.request(method, suffix, body)
        record = json.loads(captured.output[-1].split('iwinv_api_transport_failure ', 1)[1])
        self.assertEqual(record['failureKind'], kind)
        self.assertEqual(record['phase'], phase)
        self.assertGreaterEqual(record['elapsedMs'], 0)
        self.assertEqual(opener.calls, 1)
        for secret in ('private-access', 'private-secret', '@everyone', 'api-kr.iwinv.kr'):
            self.assertNotIn(secret, '\n'.join(captured.output))
        return record

    def test_open_errors_are_classified_without_exception_text(self):
        for error, kind in [
            (TimeoutError('private-secret'), 'timeout'),
            (urllib.error.URLError(socket.gaierror(-2, 'private-secret')), 'dns'),
            (urllib.error.URLError(ssl.SSLError('private-secret')), 'tls'),
            (ConnectionResetError(104, 'private-secret'), 'connection'),
            (http.client.RemoteDisconnected('private-secret'), 'connection'),
            (RuntimeError('private-secret @everyone'), 'unexpected'),
        ]:
            with self.subTest(kind=kind):
                class Opener:
                    calls = 0
                    def open(self, *args, **kwargs):
                        self.calls += 1
                        raise error
                self.check_failure(Opener(), kind, 'connect')

    def test_malformed_body_is_decode_failure_without_body(self):
        for body in (b'<html>private-secret @everyone</html>', b'\xff'):
            class Opener:
                calls = 0
                def open(self, *args, **kwargs):
                    self.calls += 1
                    return io.BytesIO(body)
            self.check_failure(Opener(), 'invalid_json', 'decode')

    def test_read_failure_is_distinguished(self):
        class Response(io.BytesIO):
            def read(self, *args):
                raise http.client.IncompleteRead(b'private-secret')
        class Opener:
            calls = 0
            def open(self, *args, **kwargs):
                self.calls += 1
                return Response()
        self.check_failure(Opener(), 'incomplete_response', 'read')

    def test_uncertain_mutations_are_never_repeated(self):
        for method, suffix, body in [
            ('DELETE', '/rules/123', None),
            ('POST', '/rules', {'bound': 'OUT', 'protocol': 'TCP', 'port': '8041',
                              'ip': '8.8.8.8/32', 'title': 'blg-auto-'+'a'*16,
                              'content': 'SOOP verified outbound'}),
        ]:
            class Opener:
                calls = 0
                def open(self, *args, **kwargs):
                    self.calls += 1
                    raise TimeoutError('private-secret')
            record = self.check_failure(Opener(), 'timeout', 'connect', method, suffix, body)
            self.assertNotIn('123', record['operation'])


if __name__ == '__main__':
    unittest.main()
