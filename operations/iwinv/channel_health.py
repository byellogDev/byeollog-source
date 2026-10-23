"""Pure channel/egress assessment. Does not connect, change rules, or send alerts."""
import ipaddress
import hashlib

GRACE_SECONDS = 90


def assess_channels(channels, previous, now, *, fresh=True):
    previous = previous if isinstance(previous, dict) else {}
    if not fresh:
        return previous, {'channelErrors': max(1, sum(bool(x.get('failed')) for x in previous.values())),
                          'channelRecoveryConfirmed': False, 'channelHealthReasons': ['worker_stale']}
    if not isinstance(channels, list) or len(channels) > 1000:
        return previous, {'channelErrors': 1, 'channelRecoveryConfirmed': False,
                          'channelHealthReasons': ['channel_telemetry_invalid']}
    current, reasons, pending = {}, set(), False
    for channel in channels:
        if not isinstance(channel, dict) or not isinstance(channel.get('workspace'), str) or not channel['workspace'] or channel['workspace'] in current:
            reasons.add('channel_telemetry_invalid')
            continue
        tag = channel['workspace']
        old = previous.get(tag, {})
        state, error = channel.get('state'), channel.get('lastErrorCode')
        confirmed = (state == 'connected' and not error) or (state == 'waiting_for_live' and error == 'broadcast_offline')
        if confirmed:
            current[tag] = {'failed': False, 'pendingSince': None}
            continue
        pending = True
        since = old.get('pendingSince')
        if not isinstance(since, (int, float)) or since > now:
            since = now
        failed = bool(old.get('failed')) or bool(error and error != 'broadcast_offline')
        failed = failed or state not in ('connecting', 'idle') or now - since >= GRACE_SECONDS
        current[tag] = {'failed': failed, 'pendingSince': since}
        if failed:
            reasons.add('connection_not_ready')
    # Disappearing telemetry is not evidence that an incident recovered.
    for tag, old in previous.items():
        if tag not in current and old.get('failed'):
            current[tag] = old
            reasons.add('failed_channel_missing')
    errors = sum(bool(x['failed']) for x in current.values())
    if 'channel_telemetry_invalid' in reasons:
        errors = max(1, errors)
    return current, {'channelErrors': errors, 'channelRecoveryConfirmed': not errors and not pending,
                     'channelHealthReasons': sorted(reasons)}


def assess_ports(socket_text, allowed_ports, previous_unapproved, approved_destinations=None, previous_endpoints=None):
    allowed = set(allowed_ports)
    observed, syn = set(), set()
    approved = {(x['digest'], x['port']) for x in (approved_destinations or [])}
    remembered = {(x['digest'], x['port']) for x in (previous_endpoints or [])}
    unknown = set(remembered)
    for line in socket_text.splitlines():
        fields = line.split()
        if len(fields) < 5 or fields[0] not in ('ESTAB', 'SYN-SENT'):
            continue
        try:
            host, port = fields[4].rsplit(':', 1)
            address, port = ipaddress.ip_address(host.strip('[]')), int(port)
        except ValueError:
            continue
        if not address.is_global or not 1 <= port <= 65535:
            continue
        observed.add(port)
        fingerprint = hashlib.sha256(f'{address}:{port}'.encode()).hexdigest()
        unknown.add((fingerprint, port))
        if fields[0] == 'SYN-SENT':
            syn.add(port)
    # Do not hide a discovered gap simply because the socket timed out.
    # Permission is per destination, not per port. Approving one IP must not
    # conceal a different IP using the same port. Legacy unknown ports remain
    # unresolved until explicitly approved; modern records retain keyed proof.
    unknown = {(key, port) for key, port in unknown if port not in allowed and (key, port) not in approved}
    legacy = set(previous_unapproved) - {port for _, port in remembered}
    unapproved = ({port for _, port in unknown} | legacy) - allowed
    return {'observedEgressPorts': sorted(observed), 'synSentPorts': sorted(syn),
            'unapprovedEgressPorts': sorted(unapproved),
            'unapprovedEgressEndpoints': [{'digest': key, 'port': port} for key, port in sorted(unknown)]}
