#!/bin/sh
set -eu

archive='/tmp/gateway-browser-context-isolation-20260906.tar.gz'
expected='5b60cf6b152e48d306ae8955d7768ade410d448fb4b1ebc0b7c67cd3e6753481'
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

stamp='20260906-browser-context-isolation'
service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image="soop-chat-gateway-soop-gateway:rollback-${stamp}"
backup="/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz"
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'
browser_file='/opt/byeollog/services/soop-chat-gateway/browser-session.mjs'
probe_file='/opt/byeollog/services/soop-chat-gateway/storage-isolation-probe.mjs'
probe_container="byeollog-soop-isolation-probe-${stamp}"
probe_existed=0
patched=0
restarted=0

rollback_on_failure() {
  exit_code=$?
  docker rm -f "$probe_container" >/dev/null 2>&1 || true
  if [ "$patched" -eq 1 ]; then
    if [ "$probe_existed" -eq 0 ]; then rm -f "$probe_file"; fi
    tar -xzf "$backup" -C /opt/byeollog || true
    docker tag "$rollback_image" "$service_image" || true
    if [ "$restarted" -eq 1 ]; then
      docker compose -f "$compose" up -d --no-build --force-recreate || true
    fi
  fi
  exit "$exit_code"
}
trap rollback_on_failure EXIT HUP INT TERM

install -d -m 700 /opt/byeollog/backups
if [ -f "$probe_file" ]; then
  probe_existed=1
  tar -czf "$backup" -C /opt/byeollog \
    services/soop-chat-gateway/browser-session.mjs \
    services/soop-chat-gateway/storage-isolation-probe.mjs
else
  tar -czf "$backup" -C /opt/byeollog \
    services/soop-chat-gateway/browser-session.mjs
fi
docker tag "$service_image" "$rollback_image"
tar -xzf "$archive" -C /opt/byeollog
chown root:root "$browser_file" "$probe_file"
chmod 644 "$browser_file" "$probe_file"
grep -Fq "storageIsolation:'browser_context'" "$browser_file"
grep -Fq 'Target.createBrowserContext' "$browser_file"
grep -Fq 'Target.disposeBrowserContext' "$browser_file"

patched=1
docker compose -f "$compose" build soop-gateway

# Candidate image must demonstrate cookie and localStorage separation before
# it can replace the running collector. No streamer token is supplied here.
timeout 60s docker run --rm --name "$probe_container" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 256 --memory 2g --entrypoint node \
  "$service_image" services/soop-chat-gateway/storage-isolation-probe.mjs \
  | grep -Fq '{"isolated":true,"contextsDistinct":true}'

restarted=1
docker compose -f "$compose" up -d --no-build --force-recreate

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done

docker logs --tail 100 soop-chat-gateway-soop-gateway-1 2>&1 \
  | grep -Fq '"storageIsolation":"browser_context"'
docker logs --tail 100 soop-chat-gateway-soop-gateway-1 2>&1 \
  | grep -Fq '"sessionsPerShard":1'

patched=0
restarted=0
trap - EXIT HUP INT TERM
rm -f "$archive"
