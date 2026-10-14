#!/usr/bin/env python3
"""Root-owned observation timer; no provider keys and no firewall mutations."""
import hashlib
import ipaddress
import json
import os
import subprocess
import time
from pathlib import Path


def active_digests(text):
    active = set()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[0] not in ('ESTAB', 'SYN-SENT'): continue
        try:
            ip, port = fields[4].rsplit(':', 1)
            ip, port = ipaddress.ip_address(ip.strip('[]')), int(port)
            if ip.version != 4 or not ip.is_global or not 1 <= port <= 65535: continue
        except ValueError: continue
        active.add(hashlib.sha256(f'{ip}:{port}'.encode()).hexdigest())
    return sorted(active)


def main():
    data = {'at': time.time(), 'ok': False, 'active': []}
    try:
        raw = subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', 'soop-chat-gateway-soop-gateway-1'], timeout=10, text=True)
        state = json.loads(raw)
        pid = state.get('Pid')
        if state.get('Running') is not True or type(pid) != int or pid < 2: raise ValueError()
        sockets = subprocess.check_output(['nsenter', '-t', str(pid), '-n', 'ss', '-H', '-n', '-t'], timeout=10, text=True)
        data.update(ok=True, active=active_digests(sockets))
    except Exception: pass
    directory = Path('/var/lib/byeollog-egress-observer')
    directory.mkdir(mode=0o755, exist_ok=True)
    temporary = directory/'connections.tmp'
    temporary.write_text(json.dumps(data))
    temporary.chmod(0o644)
    temporary.replace(directory/'connections.json')
    return 0 if data['ok'] else 1


if __name__ == '__main__': raise SystemExit(main())
