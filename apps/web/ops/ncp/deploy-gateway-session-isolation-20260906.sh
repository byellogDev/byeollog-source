#!/bin/sh
set -eu

archive='/tmp/gateway-session-isolation-20260906.tar.gz'
expected='7e82443c8783f98434b6d43ff0cded790bd816518b808c77577f201599ad641f'
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

stamp='20260906-session-isolation'
service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image="soop-chat-gateway-soop-gateway:rollback-${stamp}"
backup="/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz"
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'
deployed=0

rollback_on_failure() {
  exit_code=$?
  if [ "$deployed" -eq 1 ]; then
    tar -xzf "$backup" -C /opt/byeollog || true
    docker tag "$rollback_image" "$service_image" || true
    docker compose -f "$compose" up -d --no-build --force-recreate || true
  fi
  exit "$exit_code"
}
trap rollback_on_failure EXIT HUP INT TERM

install -d -m 700 /opt/byeollog/backups
tar -czf "$backup" -C /opt/byeollog services/soop-chat-gateway/browser-session.mjs
docker tag "$service_image" "$rollback_image"
tar -xzf "$archive" -C /opt/byeollog
chown root:root /opt/byeollog/services/soop-chat-gateway/browser-session.mjs
chmod 644 /opt/byeollog/services/soop-chat-gateway/browser-session.mjs
grep -Fq 'sessionsPerShard:1' /opt/byeollog/services/soop-chat-gateway/browser-session.mjs

deployed=1
docker compose -f "$compose" up -d --build

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done

docker logs --tail 80 soop-chat-gateway-soop-gateway-1 2>&1 \
  | grep -Fq '"sessionsPerShard":1'

deployed=0
trap - EXIT HUP INT TERM
rm -f "$archive"
