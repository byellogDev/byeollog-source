#!/bin/sh
set -eu

archive="${1:-/tmp/gateway-workspace-ownership-20260907.tar.gz}"
expected="${2:-}"
[ -n "$expected" ]
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

stamp='20260907-workspace-ownership'
service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image="soop-chat-gateway-soop-gateway:rollback-${stamp}"
backup="/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz"
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'
index_file='/opt/byeollog/services/soop-chat-gateway/index.mjs'
browser_file='/opt/byeollog/services/soop-chat-gateway/browser-session.mjs'
patched=0
restarted=0

rollback_on_failure() {
  exit_code=$?
  if [ "$patched" -eq 1 ]; then
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
tar -czf "$backup" -C /opt/byeollog \
  services/soop-chat-gateway/index.mjs \
  services/soop-chat-gateway/browser-session.mjs
docker tag "$service_image" "$rollback_image"
tar -xzf "$archive" -C /opt/byeollog
chown root:root "$index_file" "$browser_file"
chmod 644 "$index_file" "$browser_file"

grep -Fq 'expectedBroadcasterId:token.providerAccountId' "$index_file"
grep -Fq 'leaseToken:token.leaseToken' "$index_file"
grep -Fq "storageIsolation:'browser_context'" "$browser_file"
grep -Fq 'Target.createBrowserContext' "$browser_file"
grep -Fq 'sessionsPerShard:1' "$browser_file"

patched=1
docker compose -f "$compose" build soop-gateway
restarted=1
docker compose -f "$compose" up -d --no-build --force-recreate

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done

sleep 5
logs="$(docker logs --tail 200 soop-chat-gateway-soop-gateway-1 2>&1)"
printf '%s\n' "$logs" | grep -Fq '"event":"gateway_started"'
printf '%s\n' "$logs" | grep -Fq '"storageIsolation":"browser_context"'
printf '%s\n' "$logs" | grep -Fq '"sessionsPerShard":1'
if printf '%s\n' "$logs" | grep -Eq '"event":"(workspace_crashed|reconcile_failed)"'; then
  exit 1
fi

patched=0
restarted=0
trap - EXIT HUP INT TERM
rm -f "$archive"
