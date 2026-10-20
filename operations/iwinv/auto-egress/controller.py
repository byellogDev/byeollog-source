#!/usr/bin/env python3
"""Host-only Unix service. Provider/API secrets are never diagnostic output."""
import argparse
import fcntl
import http.server
import json
import logging
import os
import re
import socket
import socketserver
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from iwinv_api import ApiError, FirewallApi, NoRedirect
from policy import Engine, endpoint, save
from diagnostics import Diagnostics

CHATINFO = 'https://openapi.sooplive.com/broad/access/chatinfo'


def fetch_room(token):
    req = urllib.request.Request(CHATINFO, data=urllib.parse.urlencode({'access_token': token}).encode(),
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    opener = urllib.request.build_opener(NoRedirect())
    try: response = opener.open(req, timeout=7)
    except urllib.error.HTTPError as error:
        return error.code, b'{}'
    except Exception: raise ApiError('chatinfo_unavailable') from None
    with response:
        raw = response.read(65537)
        if len(raw) > 65536: raise ApiError('chatinfo_too_large')
        return response.status, raw


def resolve(host):
    return [r[4][0] for r in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)]


class Control:
    def __init__(self, config, credential):
        self.config, self.lock = config, threading.Lock()
        try:self.diagnostics=Diagnostics(Path(config['status']).with_name('diagnostics.jsonl'))
        except OSError:
            self.diagnostics=None
            logging.getLogger(__name__).warning('egress_diagnostics_unavailable')
        self.api = FirewallApi(credential['access'], credential['secret'], config['group'],
                               observer=self.diagnostics.api if self.diagnostics else None)
        self.engine = Engine(self.api, config['state'], config['baseline'])
        self.last_code, self.last_success, self.created = None, None, 0

    def status(self, code=None):
        if code is not None: self.last_code = code
        save(self.config['status'], {'schema': 1, 'at': time.time(), 'enabled': True,
             'lastError': self.last_code, 'lastSuccessAt': self.last_success,
             'ownedCount': len(self.engine.state['owned']), 'createdCount': self.created,
             'needsReview': bool(self.engine.state['frozen']),
             'diagnosticsHealthy':bool(getattr(self,'diagnostics',None) and not self.diagnostics.handler.failed),
             'lastApi':getattr(self.api,'last_observation',None),
             'ownedDestinations': [{'digest': __import__('policy').digest(e['ip'], e['port']), 'port': e['port']}
                                  for e in self.engine.state['owned'] if not e.get('pending') and not e.get('deleting')]})

    def check_association(self):
        # Exact association shape is pinned during the read-only deployment
        # preflight. Unknown/missing/paginated response fails closed.
        expected = self.config['association']
        value = self.api.request('GET', '/instances')
        rows = value.get('result')
        field = expected.get('idField')
        if field not in ('id', 'instance_id', 'uuid') or not isinstance(rows, list) or value.get('count') != len(rows):
            self.engine.freeze('instance_association_drift')
        ids = [str(row.get(field, '')) for row in rows if isinstance(row, dict)]
        if len(ids) != len(rows) or not ids or sorted(ids) != sorted(expected.get('ids', [])):
            self.engine.freeze('instance_association_drift')

    def chatinfo(self, request):
        if not isinstance(request, dict) or set(request) != {'owner', 'accessToken'}:
            raise ApiError('invalid_request')
        token, owner = request['accessToken'], request['owner']
        if (not isinstance(token, str) or not 1 <= len(token) <= 8192 or re.search(r'[\x00-\x20\x7f]', token)
                or not isinstance(owner, str) or not re.fullmatch(r'[a-z0-9_.-]{2,80}', owner)):
            raise ApiError('invalid_request')
        status, raw = fetch_room(token)
        if status != 200: return status, b'{}'
        try: data = json.loads(raw)
        except (ValueError, UnicodeError): raise ApiError('invalid_chatinfo') from None
        destination = endpoint(data, owner, resolve)
        if destination:
            with self.lock:
                # Baseline ports require no new permission. New endpoints
                # require a fresh group-to-instance check before mutations.
                from policy import covers
                if not any(covers(r, *destination) for r in self.engine.baseline): self.check_association()
                result = self.engine.ensure(*destination)
                self.created += int(result == 'created')
                self.last_success = time.time()
                self.status()
        return 200, raw

    def maintain(self):
        while True:
            with self.lock:
                started=time.monotonic();phase='association'
                try:
                    self.check_association()
                    phase='observation'
                    observation = json.loads(Path(self.config['observation']).read_text())
                    phase='cleanup'
                    self.engine.cleanup(observation)
                    phase='complete'
                    self.last_code = None
                except ApiError as error: self.last_code = error.code
                except Exception: self.last_code = 'controller_maintenance_failed'
                if self.diagnostics:
                    try:self.diagnostics.cycle(phase,self.last_code,round((time.monotonic()-started)*1000),self.api.last_observation)
                    except Exception:
                        self.diagnostics.handler.failed=True
                self.status()
            time.sleep(30)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16

    def verify_request(self, request, client_address):
        # Local kernel identity, not a client-supplied header.
        pid, uid, gid = struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid in (0, self.control.config['collectorUid'])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def setup(self):
        self.request.settimeout(12)
        super().setup()

    def do_POST(self):
        code, raw = 503, b'{"error":"egress_controller_unavailable"}'
        try:
            length = self.headers.get('Content-Length', '')
            if self.path != '/chatinfo' or not length.isdigit() or not 1 <= int(length) <= 12288 or self.headers.get('Transfer-Encoding'):
                raise ApiError('invalid_request')
            request = json.loads(self.rfile.read(int(length)))
            code, raw = self.server.control.chatinfo(request)
        except ApiError as error:
            with self.server.control.lock: self.server.control.status(error.code)
            raw = json.dumps({'error': 'egress_'+error.code}).encode()
        except Exception:
            with self.server.control.lock: self.server.control.status('controller_request_failed')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(raw)
        except (OSError, TimeoutError): pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    lock = open(Path(config['state']).with_name('controller.lock'), 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    credential = json.loads((Path(os.environ['CREDENTIALS_DIRECTORY'])/'iwinv.json').read_text())
    control = Control(config, credential)
    # Startup never creates/deletes a rule, and refuses wrong group/rules.
    control.check_association()
    control.engine.refresh()
    path = Path(config['socket'])
    if path.exists():
        if not path.is_socket(): raise ApiError('socket_path_invalid')
        path.unlink()
    with Server(str(path), Handler) as server:
        server.control = control
        os.chmod(path, 0o660)
        control.status()
        threading.Thread(target=control.maintain, daemon=True).start()
        server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    try: main()
    except Exception:
        # No traceback: config/HTTP objects may contain provider credentials.
        print('egress_controller_start_failed', flush=True)
        raise SystemExit(1)
