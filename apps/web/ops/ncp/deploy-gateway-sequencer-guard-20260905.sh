#!/bin/sh
set -eu

archive='/tmp/gateway-sequencer-guard-20260905.tar.gz'
expected='52d046a18630c576d18c4968ed61653d7cd5dec25fd19bcdf7a84150de57a513'
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

stamp='20260905-sequencer-guard'
install -d -m 700 /opt/byeollog/backups
tar -czf "/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz" \
  -C /opt/byeollog \
  services/soop-chat-gateway/index.mjs \
  services/soop-chat-gateway/workspace-event-sequencer.mjs

docker tag soop-chat-gateway-soop-gateway:latest \
  "soop-chat-gateway-soop-gateway:rollback-${stamp}"
tar -xzf "$archive" -C /opt/byeollog
chown root:root \
  /opt/byeollog/services/soop-chat-gateway/index.mjs \
  /opt/byeollog/services/soop-chat-gateway/workspace-event-sequencer.mjs
chmod 644 \
  /opt/byeollog/services/soop-chat-gateway/index.mjs \
  /opt/byeollog/services/soop-chat-gateway/workspace-event-sequencer.mjs

cd /opt/byeollog/services/soop-chat-gateway
docker compose -f compose.example.yml up -d --build

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done

rm -f "$archive"
