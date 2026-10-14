"""Linux Unix-socket integration with fake provider and fake firewall only."""
import importlib.util
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path

if sys.platform != 'linux':
    raise SystemExit('Linux required: run in the isolated candidate environment')

import controller
from policy import ApiError, Engine
spec = importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('policy.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)
        self.control=controller.Control.__new__(controller.Control)
        self.control.config={'status':str(self.path/'status.json'),'collectorUid':10001,
                             'association':{'idField':'instance_id','ids':['fixture-server']}}
        self.control.lock=threading.Lock()
        self.control.api=fixtures.FakeApi()
        self.control.api.request=lambda method,path:{'count':1,'result':[{'instance_id':'fixture-server','status':'running'}]}
        self.control.engine=Engine(self.control.api,self.path/'state.json',fixtures.BASE)
        self.control.last_code=None;self.control.last_success=None;self.control.created=0
        self.original_fetch,self.original_resolve=controller.fetch_room,controller.resolve
        controller.fetch_room=lambda token:(200,json.dumps({'result':1,'data':[{'id':'fixture','chat_ip':'110.10.76.111','chat_port':9100,'chat_no':1,'key':'fake-room-ticket'}]}).encode())
        controller.resolve=lambda host:['110.10.76.111']
        self.addCleanup(self.restore)

    def restore(self):controller.fetch_room,controller.resolve=self.original_fetch,self.original_resolve

    def test_unix_request_has_provider_reply_and_no_secrets_in_state(self):
        sock=str(self.path/'control.sock')
        server=controller.Server(sock,controller.Handler)
        server.control=self.control
        self.control.config['collectorUid']=os.getuid()
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            body=json.dumps({'owner':'fixture','accessToken':'fake-oauth-token'}).encode()
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                client.settimeout(5);client.connect(sock)
                client.sendall(b'POST /chatinfo HTTP/1.1\r\nHost: localhost\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
                chunks=[]
                while True:
                    part=client.recv(8192)
                    if not part:break
                    chunks.append(part)
            response=b''.join(chunks)
            self.assertIn(b'200 OK',response)
            self.assertIn(b'fake-room-ticket',response)
            self.assertEqual(self.control.api.posts,1)
            for path in self.path.glob('*.json'):
                text=path.read_text()
                self.assertNotIn('fake-oauth-token',text)
                self.assertNotIn('fake-room-ticket',text)
        finally:server.shutdown();server.server_close();thread.join()

    def test_untrusted_local_uid_rejected(self):
        class Peer:
            def getsockopt(self,*args):return struct.pack('3i',1,12345,10001)
        server=controller.Server(str(self.path/'control.sock'),controller.Handler)
        try:
            server.control=self.control
            self.assertFalse(server.verify_request(Peer(),None))
        finally:server.server_close()

    def test_association_drift_prevents_create(self):
        self.control.api.request=lambda *args:{'count':1,'result':[{'instance_id':'other-server'}]}
        with self.assertRaisesRegex(ApiError,'instance_association_drift'):
            self.control.chatinfo({'owner':'fixture','accessToken':'fake-oauth-token'})
        self.assertEqual(self.control.api.posts,0)

    def test_client_supplied_target_is_rejected(self):
        with self.assertRaisesRegex(ApiError,'invalid_request'):
            self.control.chatinfo({'owner':'fixture','accessToken':'fake-oauth-token','ip':'8.8.8.8','port':22})
        self.assertEqual(self.control.api.posts,0)

    def test_dns_mismatch_prevents_create(self):
        controller.resolve=lambda host:['8.8.8.8']
        with self.assertRaisesRegex(ApiError,'chatinfo_dns_mismatch'):
            self.control.chatinfo({'owner':'fixture','accessToken':'fake-oauth-token'})
        self.assertEqual(self.control.api.posts,0)

if __name__=='__main__':unittest.main()
