"""Fail-closed policy for provider-verified outbound destinations.

The caller never supplies a destination: only a response fetched directly from
SOOP is accepted. Existing rules are immutable. An uncertain POST is reconciled
by its durable random marker before any further creation.
"""
import hashlib
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path
from iwinv_api import ApiError


def save(path, value):
    path = Path(path)
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as out:
        json.dump(value, out, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)
    if os.name != 'nt':
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def endpoint(response, owner, resolve):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{2,80}', owner or ''):
        raise ApiError('invalid_owner')
    if not isinstance(response, dict):
        raise ApiError('invalid_chatinfo')
    # Offline/provider errors do not authorize any firewall change.
    result = response.get('result')
    if not re.fullmatch(r'-?[0-9]{1,10}', str(result)):
        raise ApiError('invalid_chatinfo')
    if int(result) <= 0:
        return None
    rows = response.get('data')
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ApiError('invalid_chatinfo')
    row = rows[0]
    if row.get('id') != owner:
        raise ApiError('chatinfo_owner_mismatch')
    try:
        ip = ipaddress.IPv4Address(row.get('chat_ip'))
        raw_port = str(row.get('chat_port'))
        if not re.fullmatch(r'[0-9]{1,5}', raw_port): raise ValueError()
        port = int(raw_port) + 1
        if not ip.is_global or not 1024 <= port <= 65535: raise ValueError()
        if not re.fullmatch(r'[1-9][0-9]{0,15}', str(row.get('chat_no'))): raise ValueError()
        ticket = row.get('key')
        if not isinstance(ticket, str) or not 1 <= len(ticket) <= 8192 or re.search(r'[\x00-\x20\x7f]', ticket): raise ValueError()
    except (ValueError, TypeError):
        raise ApiError('invalid_destination') from None
    host = 'chat-' + ''.join(f'{part:02x}' for part in ip.packed) + '.sooplive.com'
    addresses = set(resolve(host))
    # Do not open the API IP if DNS would send the collector somewhere else.
    if addresses != {str(ip)}:
        raise ApiError('chatinfo_dns_mismatch')
    return str(ip), port


def rule(row):
    if not isinstance(row, dict): raise ApiError('invalid_rule')
    try:
        rid = str(row['rule_id'])
        if not re.fullmatch(r'[0-9]+', rid): raise ValueError()
        bound = str(row['bound']).upper()
        bound = {'INBOUND': 'IN', 'OUTBOUND': 'OUT'}.get(bound, bound)
        if bound not in ('IN', 'OUT'): raise ValueError()
        return (rid, bound, str(row['protocol']).upper(), str(row['port']),
                str(ipaddress.ip_network(row['ip'], strict=False)),
                str(row.get('title', '')), str(row.get('content', '')))
    except (KeyError, ValueError, TypeError):
        raise ApiError('invalid_rule') from None


def covers(row, ip, port):
    # Only explicit outbound TCP single-port rules qualify. No inferred ALL
    # or provider-specific port-range semantics.
    return row[1:4] == ('OUT', 'TCP', str(port)) and ipaddress.ip_address(ip) in ipaddress.ip_network(row[4])


def digest(ip, port):
    return hashlib.sha256(f'{ip}:{port}'.encode()).hexdigest()


class Engine:
    def __init__(self, api, path, baseline, *, clock=time.time, max_rules=24):
        if type(max_rules) != int or not 1 <= max_rules <= 24: raise ApiError('invalid_rule_limit')
        self.api, self.path, self.clock, self.max_rules = api, Path(path), clock, max_rules
        self.baseline = sorted(rule(r) for r in baseline)
        if not self.baseline: raise ApiError('baseline_empty')
        if len({r[0] for r in self.baseline}) != len(self.baseline): raise ApiError('duplicate_rule_id')
        try: self.state = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError: self.state = {'schema': 1, 'owned': [], 'created': [], 'frozen': None}
        if self.state.get('schema') != 1 or not isinstance(self.state.get('owned'), list):
            raise ApiError('state_invalid')
        self.cached, self.checked = [], 0

    def persist(self): save(self.path, self.state)

    def freeze(self, code):
        self.state['frozen'] = code
        self.persist()
        raise ApiError(code)

    def refresh(self):
        rows = [rule(r) for r in self.api.rules()]
        if len({r[0] for r in rows}) != len(rows): self.freeze('duplicate_rule_id')
        by_id = {r[0]: r for r in rows}
        if any(by_id.get(r[0]) != r for r in self.baseline): self.freeze('baseline_drift')
        baseline_ids = {r[0] for r in self.baseline}
        owned_ids = set()
        for entry in self.state['owned']:
            matches = [r for r in rows if r[5] == entry['title']]
            if len(matches) > 1: self.freeze('owned_rule_ambiguous')
            if matches:
                row = matches[0]
                if row[0] in baseline_ids: self.freeze('owned_rule_overlaps_baseline')
                expected = ('OUT', 'TCP', str(entry['port']), entry['ip']+'/32', entry['title'], 'SOOP verified outbound')
                if row[1:] != expected or (entry.get('id') and row[0] != entry['id']): self.freeze('owned_rule_drift')
                entry['id'], entry['pending'] = row[0], False
                owned_ids.add(row[0])
            elif entry.get('pending'):
                # A lost POST response can arrive after the first list read.
                # Never retry POST automatically for this uncertain operation.
                self.persist()
                raise ApiError('create_outcome_unknown')
            elif not entry.get('deleting'):
                self.freeze('owned_rule_missing')
        if any(r[0] not in baseline_ids | owned_ids for r in rows): self.freeze('unreviewed_rule_drift')
        self.state['owned'] = [e for e in self.state['owned'] if not (e.get('deleting') and e.get('id') not in by_id)]
        self.persist()
        self.cached, self.checked = rows, self.clock()
        return rows

    def ensure(self, ip, port):
        try:
            if not ipaddress.IPv4Address(ip).is_global or type(port) != int or not 1 <= port <= 65535: raise ValueError()
        except (ValueError, TypeError): raise ApiError('invalid_destination') from None
        now = self.clock()
        # Existing manually approved ports remain usable if controller API
        # access fails. No new permission is inferred from this fast path.
        if any(covers(r, ip, port) for r in self.baseline): return 'baseline'
        if port < 1024: raise ApiError('invalid_destination')
        if self.state['frozen']: raise ApiError(self.state['frozen'])
        entry = next((e for e in self.state['owned'] if (e['ip'], e['port']) == (ip, port)), None)
        if entry and not entry.get('pending') and not entry.get('deleting') and now - self.checked < 30:
            entry['lastUsed'] = now
            self.persist()
            return 'existing'
        rows = self.refresh()
        if entry and entry in self.state['owned'] and entry.get('deleting'):
            raise ApiError('delete_outcome_pending')
        if entry and entry in self.state['owned'] and not entry.get('deleting'):
            entry['lastUsed'] = now
            self.persist()
            return 'existing'
        if len(self.state['owned']) >= self.max_rules: raise ApiError('rule_capacity')
        self.state['created'] = [t for t in self.state['created'] if now-t < 60]
        if len(self.state['created']) >= 6: raise ApiError('creation_rate_limit')
        entry = {'ip': ip, 'port': port, 'title': 'blg-auto-'+secrets.token_hex(8),
                 'lastUsed': now, 'pending': True, 'id': None}
        self.state['owned'].append(entry)
        self.state['created'].append(now)
        self.persist()  # Commit intent before the provider mutation.
        try: self.api.create(ip, port, entry['title'])
        except ApiError:
            # Reconcile once; a missing result remains pending across restart.
            self.refresh()
            return 'created'
        self.refresh()
        return 'created'

    def cleanup(self, observation):
        if self.state['frozen']: raise ApiError(self.state['frozen'])
        now = self.clock()
        if (not isinstance(observation, dict) or observation.get('ok') is not True or
                type(observation.get('at')) not in (int, float) or not -5 <= now-observation['at'] <= 90 or
                not isinstance(observation.get('active'), list) or
                any(not isinstance(x, str) or not re.fullmatch(r'[a-f0-9]{64}', x) for x in observation['active'])):
            raise ApiError('connection_observation_stale')
        self.refresh()
        for entry in list(self.state['owned']):
            if entry.get('pending'): continue
            if digest(entry['ip'], entry['port']) in observation['active']:
                entry['lastUsed'] = now
                continue
            if now-entry['lastUsed'] < 900: continue
            entry['deleting'] = True
            self.persist()
            # refresh above verified the precise owned rule id + tuple.
            self.api.delete_owned(entry['id'])
            self.refresh()
        self.persist()
