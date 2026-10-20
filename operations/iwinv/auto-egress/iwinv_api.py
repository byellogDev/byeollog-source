"""Bounded iwinv client: one configured security group, never instance control."""
import hashlib
import hmac
import json
import logging
import re
import socket
import ssl
import time
import http.client
from email.utils import parsedate_to_datetime
import urllib.error
import urllib.request

class ApiError(Exception):
    def __init__(self, code):
        super().__init__(code); self.code=code

def signature(secret, timestamp, path):
    if not path.startswith('/v1/') or '?' in path or path.endswith('/'):
        raise ApiError('invalid_signing_path')
    return hmac.new(secret.encode(), (str(timestamp)+path).encode(), hashlib.sha256).hexdigest()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ApiError('api_redirect_denied')


def record_transport_failure(error, method, suffix, phase, elapsed, observed_at):
    # Never serialize exceptions: reason/args can contain URLs, keys or body.
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLError): kind = 'tls'
    elif isinstance(reason, socket.gaierror): kind = 'dns'
    elif isinstance(reason, TimeoutError): kind = 'timeout'
    elif isinstance(reason, (json.JSONDecodeError, UnicodeDecodeError)): kind = 'invalid_json'
    elif isinstance(reason, http.client.IncompleteRead): kind = 'incomplete_response'
    elif isinstance(reason, (ConnectionError, http.client.RemoteDisconnected)): kind = 'connection'
    elif isinstance(reason, OSError): kind = 'os_error'
    else: kind = 'unexpected'
    errno = getattr(reason, 'errno', None)
    logging.getLogger(__name__).warning('iwinv_api_transport_failure %s', json.dumps({
        'failureKind': kind, 'phase': phase,
        'errno': errno if type(errno) == int and -10000 <= errno <= 10000 else None,
        'operation': method+' '+('/rules/item' if method == 'DELETE' else suffix or '/group'),
        'elapsedMs': round(max(0, elapsed)*1000), 'observedAt': round(observed_at, 3)
    }, sort_keys=True))


def record_http_failure(error, method, suffix, timestamp, observed_at):
    # HTTPError may contain credentials in its URL, reason, headers or body.
    # Persist only enumerated codes and numeric times in the service journal.
    provider = 'OTHER'
    server_at = None
    try:
        raw = error.read(4097)
        value = json.loads(raw) if len(raw) <= 4096 else None
        code = value.get('error_code') if isinstance(value, dict) else None
        if code in ('INVALID_SIGNATURE', 'INVALID_CREDENTIAL', 'UNAUTHORIZED',
                    'ACCESS_DENIED', 'RATE_LIMIT_EXCEEDED'):
            provider = code
    except Exception:
        pass
    try:
        candidate = parsedate_to_datetime(error.headers.get('Date', '')).timestamp()
        if abs(candidate-observed_at) <= 86400: server_at = int(candidate)
    except (ValueError, TypeError, AttributeError, OverflowError):
        pass
    logging.getLogger(__name__).warning('iwinv_api_failure %s', json.dumps({
        'httpStatus': error.code, 'providerCode': provider,
        'operation': method+' '+('/rules/item' if method=='DELETE' else suffix or '/group'),
        'requestTimestamp': timestamp, 'observedAt': round(observed_at, 3),
        'serverTimestamp': server_at}, sort_keys=True))


class FirewallApi:
    def __init__(self, access, secret, group, *, opener=None, clock=time.time, sleep=time.sleep):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(group)):
            raise ApiError('invalid_group')
        self.access,self.secret,self.group=access,secret,str(group)
        self.opener=opener or urllib.request.build_opener(NoRedirect())
        self.clock,self.sleep=clock,sleep
        self.last_call=0

    def request(self, method, suffix='', body=None):
        if (method,suffix) not in [('GET',''),('GET','/rules'),('GET','/instances'),('POST','/rules')] and not (method=='DELETE' and re.fullmatch(r'/rules/[0-9]+',suffix)):
            raise ApiError('api_operation_denied')
        if method=='POST':
            import ipaddress
            try:
                if not isinstance(body,dict) or set(body)!=set(('bound','protocol','port','ip','title','content')):raise ValueError()
                network=ipaddress.IPv4Network(body['ip'],strict=True)
                if network.prefixlen!=32 or not network.network_address.is_global or body['bound']!='OUT' or body['protocol']!='TCP' or not re.fullmatch(r'[0-9]{4,5}',body['port']) or not 1024<=int(body['port'])<=65535 or not re.fullmatch(r'blg-auto-[a-f0-9]{16}',body['title']) or body['content']!='SOOP verified outbound':raise ValueError()
            except (ValueError,TypeError,KeyError):raise ApiError('api_mutation_denied') from None
        # Stay below the provider's 60/minute limit, including verification reads.
        wait=1.1-(self.clock()-self.last_call)
        if wait>0:self.sleep(wait)
        now=self.clock();self.last_call=now
        # The provider rejects a just-entered second when its clock is still
        # in the preceding second (401 INVALID_SIGNATURE, reproduced live).
        # One second of backward slack is inside its documented 5-minute
        # validity window. Header and HMAC always use this same captured value.
        timestamp=int(now)-1
        path='/v1/security-groups/'+self.group+suffix
        headers={'X-iwinv-Timestamp':str(timestamp),'X-iwinv-Credential':self.access,
                 'X-iwinv-Signature':signature(self.secret,timestamp,path),'Content-Type':'application/json'}
        req=urllib.request.Request('https://api-kr.iwinv.kr'+path,
            data=json.dumps(body,separators=(',',':')).encode() if body is not None else None,
            headers=headers,method=method)
        started=time.monotonic();phase='connect'
        try:
            with self.opener.open(req,timeout=8) as response:
                phase='read'
                raw=response.read(262145)
                if len(raw)>262144:raise ApiError('api_response_too_large')
                phase='decode'
                value=json.loads(raw)
        except urllib.error.HTTPError as e:
            try: record_http_failure(e, method, suffix, timestamp, self.clock())
            finally: e.close()
            raise ApiError('api_http_'+str(e.code)) from None
        except ApiError:raise
        except Exception as error:
            record_transport_failure(error,method,suffix,phase,time.monotonic()-started,self.clock())
            raise ApiError('api_unavailable') from None
        if not isinstance(value,dict) or value.get('error_code')!='SUCCESS' or str(value.get('code')).lower()!='0x00':
            raise ApiError('api_rejected')
        return value

    def rules(self):
        value=self.request('GET','/rules');rows=value.get('result')
        if not isinstance(rows,list) or value.get('count')!=len(rows) or len(rows)>500:
            raise ApiError('rules_incomplete')
        return rows

    def create(self, ip, port, title):
        # Caller supplies only an already-validated public /32 and integer port.
        import ipaddress
        try:address=ipaddress.IPv4Address(ip)
        except ValueError:raise ApiError('invalid_destination') from None
        if not address.is_global or type(port)!=int or not 1024<=port<=65535 or not re.fullmatch(r'blg-auto-[a-f0-9]{16}',title):
            raise ApiError('invalid_destination')
        return self.request('POST','/rules',{'bound':'OUT','protocol':'TCP','port':str(port),
                                            'ip':str(address)+'/32','title':title,'content':'SOOP verified outbound'})

    def delete_owned(self, rule_id):
        if not re.fullmatch(r'[0-9]+',str(rule_id)):raise ApiError('invalid_rule_id')
        return self.request('DELETE','/rules/'+str(rule_id))
