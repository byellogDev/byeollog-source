import importlib.util
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import urllib.error
import ssl
import http.client
from unittest import mock

from diagnostics import Diagnostics, host_context
from iwinv_api import ApiError, FirewallApi, ObservedHTTPSConnection

spec=importlib.util.spec_from_file_location('incident_report',Path(__file__).with_name('diagnostic-report.py'))
report_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(report_module)


class DiagnosticsTests(unittest.TestCase):
    def test_connection_instrumentation_preserves_tls_and_identifies_wait(self):
        record={}
        with mock.patch('socket.create_connection',return_value=object()) as tcp:
            connection=ObservedHTTPSConnection('example.invalid',record,timeout=8)
            self.assertEqual(connection._context.verify_mode,ssl.CERT_REQUIRED)
            self.assertTrue(connection._context.check_hostname)
            def fake_connect(inner):
                inner._create_connection(('example.invalid',443),8)
            with mock.patch.object(http.client.HTTPSConnection,'connect',fake_connect):
                connection.connect()
            self.assertEqual(tcp.call_count,1)
            self.assertIsInstance(record['tcpDnsMs'],int)
            self.assertIsInstance(record['tlsOrTunnelMs'],int)
            with mock.patch.object(http.client.HTTPSConnection,'getresponse',side_effect=TimeoutError()):
                with self.assertRaises(TimeoutError):connection.getresponse()
            self.assertEqual(record['networkPhase'],'response_headers')
            self.assertIsInstance(record['responseHeadersWaitMs'],int)

    def test_success_records_only_metadata_once(self):
        captured=[]
        class Response(io.BytesIO):
            status=200
            headers={'Content-Type':'application/json; charset=utf-8','Secret':'private-secret'}
        class Opener:
            calls=0
            def open(self,*args,**kwargs):
                self.calls+=1
                return Response(b'{"code":"0x00","error_code":"SUCCESS","result":"private-secret"}')
        opener=Opener()
        api=FirewallApi('private-access','private-secret','private-group',opener=opener,observer=captured.append)
        result=api.request('GET','/instances')
        self.assertEqual(result['result'],'private-secret')
        self.assertEqual(opener.calls,1)
        self.assertEqual(len(captured),1)
        self.assertEqual(captured[0],api.last_observation)
        self.assertEqual(captured[0]['outcome'],'ok')
        self.assertEqual(captured[0]['httpStatus'],200)
        self.assertIsInstance(captured[0]['headersMs'],int)
        self.assertIsInstance(captured[0]['bodyMs'],int)
        self.assertGreater(captured[0]['responseBytes'],0)
        self.assertNotIn('private',json.dumps(captured))

    def test_http_rejected_and_decode_failures_all_recorded(self):
        for body,expected in [(b'{"code":"bad","error_code":"private-secret"}','api_rejected'),
                              (b'<html>private-secret</html>','api_unavailable')]:
            class Opener:
                def open(self,*args,**kwargs):return io.BytesIO(body)
            captured=[]
            api=FirewallApi('private','private','42',opener=Opener(),observer=captured.append)
            with self.assertRaises(ApiError):api.request('GET','/rules')
            self.assertEqual(len(captured),1)
            self.assertEqual(captured[0]['outcome'],expected)
            self.assertNotIn('private',json.dumps(captured))
        class Opener:
            def open(self,*args,**kwargs):
                raise urllib.error.HTTPError('https://private.invalid',502,'private-secret',
                                             {'Content-Type':'text/html'},io.BytesIO(b'private-secret'))
        api=FirewallApi('private','private','42',opener=Opener(),observer=captured.append)
        with self.assertRaisesRegex(ApiError,'api_http_502'):api.request('GET','/rules')
        self.assertEqual(captured[-1]['outcome'],'api_http_502')
        self.assertEqual(captured[-1]['contentType'],'text/html')
        self.assertNotIn('private',json.dumps(captured))

    def test_observer_failure_never_replays_or_changes_response(self):
        class Opener:
            calls=0
            def open(self,*args,**kwargs):
                self.calls+=1
                return io.BytesIO(b'{"code":"0x00","error_code":"SUCCESS"}')
        def broken(record):raise OSError('private-secret')
        opener=Opener();api=FirewallApi('x','x','42',opener=opener,observer=broken)
        self.assertEqual(api.request('GET','/rules')['code'],'0x00')
        self.assertEqual(opener.calls,1)

    def test_failure_snapshots_throttled_and_rotation_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'diagnostics.jsonl';now=[1000];snapshots=[]
            def context():snapshots.append(now[0]);return {'diskFreeBytes':123}
            diag=Diagnostics(path,max_bytes=1024,backups=2,clock=lambda:now[0],context=context)
            for i in range(150):
                diag.api({'event':'api_request','at':now[0],'requestId':'a'*16,'outcome':'api_unavailable'})
            self.assertEqual(snapshots,[1000])
            now[0]+=61
            diag.api({'event':'api_request','at':now[0],'requestId':'b'*16,'outcome':'api_unavailable'})
            self.assertEqual(snapshots,[1000,1061])
            diag.close()
            files=list(Path(folder).glob('diagnostics.jsonl*'))
            self.assertEqual(len(files),3)
            self.assertLessEqual(sum(f.stat().st_size for f in files),3072)
            if os.name!='nt':
                self.assertTrue(all(f.stat().st_mode&0o777==0o600 for f in files))

    def test_log_storage_failure_is_signaled_and_can_recover(self):
        with tempfile.TemporaryDirectory() as folder:
            diag=Diagnostics(Path(folder)/'diagnostics.jsonl')
            diag.handler.stream.close();diag.handler.stream=None
            with mock.patch.object(diag.handler,'_open',side_effect=OSError('private-secret')):
                diag.write({'event':'maintenance','at':1000})
            self.assertTrue(diag.handler.failed)
            diag.write({'event':'maintenance','at':1001})
            self.assertFalse(diag.handler.failed)
            diag.close()

    def test_context_excludes_names_and_sensitive_proc_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'net').mkdir()
            (root/'meminfo').write_text('MemTotal: 100 kB\nMemAvailable: 20 kB\nprivate-secret: 99 kB\n')
            (root/'net/dev').write_text('private-interface: 0 0 2 3 0 0 0 0 0 0 4 5 0 0 0 0\n')
            value=host_context(root,root)
            self.assertEqual(value['memoryBytes'],{'MemTotal':102400,'MemAvailable':20480})
            self.assertEqual(value['networkCounters'],{'rxErrors':2,'rxDrops':3,'txErrors':4,'txDrops':5})
            self.assertNotIn('private',json.dumps(value))

    def test_report_reads_rotations_and_flags_missing_health_without_db_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);database=root/'metrics.sqlite3'
            with closing(sqlite3.connect(database)) as db:
                db.execute('create table samples(at integer,body text)')
                db.executemany('insert into samples values(?,?)',[
                    (1000,json.dumps({'channelErrors':0,'pending':0,'deadLetters':0,'secret':'private'})),
                    (1190,json.dumps({'channelErrors':1,'pending':0}))])
                db.commit()
            before=database.read_bytes()
            (root/'diagnostics.jsonl').write_text(json.dumps({'event':'api_request','at':1100,'outcome':'api_unavailable','elapsedMs':8000})+'\n')
            (root/'diagnostics.jsonl.1').write_text(json.dumps({'event':'api_request','at':1000,'outcome':'ok','elapsedMs':300})+'\n')
            result=report_module.report(root,database,950,1200)
            self.assertEqual(result['requests'],{'api_unavailable':1,'ok':1})
            self.assertEqual(result['latencyMs']['max'],8000)
            self.assertEqual(result['collectionHealth']['missingFields'],1)
            self.assertEqual(result['collectionHealth']['gapsOver120Seconds'],1)
            self.assertFalse(result['donationCompletenessVerified'])
            self.assertEqual(database.read_bytes(),before)
            self.assertNotIn('private',json.dumps(result))
            with self.assertRaises(ValueError):report_module.report(root,database,0,49*3600)


if __name__=='__main__':unittest.main()
