#!/bin/sh
set -eu
archive='/tmp/byeollog-free-infra-20260909.tar.gz'
expected="$1"
[ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected" ]
sudo -n python3 - "$archive" <<'PY'
import pathlib,tarfile,sys
allowed={'services/soop-chat-gateway/index.mjs','services/soop-chat-gateway/outbox.mjs','services/soop-chat-gateway/workspace-event-sequencer.mjs','ops/ncp/infra-health.py','test/infra-outbox.test.mjs','test/soop-gateway-outbox.test.mjs'}
dest=pathlib.Path('/opt/byeollog/infra-20260909');dest.mkdir(mode=0o700,exist_ok=True)
with tarfile.open(sys.argv[1]) as archive:
 assert {m.name for m in archive.getmembers()}==allowed
 assert all(m.isfile() for m in archive.getmembers())
 archive.extractall(dest,filter='data')
PY
sudo -n sh -c 'cd /opt/byeollog/infra-20260909; printf "%s\n" "FROM soop-chat-gateway-soop-gateway:latest" "COPY --chown=10001:10001 services/soop-chat-gateway/ /app/services/soop-chat-gateway/" "COPY --chown=10001:10001 test/ /app/test/" > Dockerfile; docker build --pull=false --network=none -t soop-chat-gateway-soop-gateway:infra-20260909 .'
sudo -n docker run --rm --network none --read-only --pids-limit 64 --memory 256m --cpus 0.5 --tmpfs /tmp:rw,noexec,nosuid,size=64m --entrypoint node soop-chat-gateway-soop-gateway:infra-20260909 --test test/infra-outbox.test.mjs test/soop-gateway-outbox.test.mjs
sudo -n python3 - <<'PY'
import importlib.util
p='/opt/byeollog/infra-20260909/ops/ncp/infra-health.py'
spec=importlib.util.spec_from_file_location('health',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s={'diskPercent':54,'memoryAvailablePercent':75,'pidPercent':74,'pending':0,'oldestAgeSeconds':0,'memoryPending':0,'container':'running:healthy','deadLetters':0,'corrupt':0}
assert m.evaluate(s)['level']=='info'
assert m.evaluate({**s,'pidPercent':96})['level']=='critical'
assert m.evaluate({**s,'oldestAgeSeconds':121})['level']=='warning'
assert m.evaluate({**s,'memoryPending':1001})['level']=='critical'
assert m.evaluate({**s,'corrupt':1})['level']=='warning'
print('PASS: five health classification cases; no restart actions')
PY
