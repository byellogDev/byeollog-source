#!/bin/sh
set -eu

archive='/tmp/gateway-sequencer-20260905.tar.gz'
expected='4fedd7bf794e44b8c73c23a4b4c9920935758b420f896e988e434bba633a1388'
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

stamp='20260905-sequencer'
install -d -m 700 /opt/byeollog/backups
tar -czf "/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz" \
  -C /opt/byeollog \
  services/soop-chat-gateway/index.mjs

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
