#!/bin/sh
set -eu

archive='/tmp/byeollog-gateway-p1p2-20260902.tar.gz'
expected='4b9e420b87e2566390d26ccf994628f8ea9eb3728847de0fc4b65667ef379a7f'
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ]

install -d -m 700 /opt/byeollog/backups
tar -czf /opt/byeollog/backups/gateway-pre-p1p2-20260902.tar.gz \
  -C /opt/byeollog \
  services/soop-chat-gateway/index.mjs \
  services/soop-chat-gateway/outbox.mjs \
  services/soop-chat-gateway/compose.example.yml \
  services/soop-chat-gateway/README.md \
  lib/soop-chat-gateway.js

docker tag soop-chat-gateway-soop-gateway:latest \
  soop-chat-gateway-soop-gateway:rollback-p1p2-20260902
tar -xzf "$archive" -C /opt/byeollog
cd /opt/byeollog/services/soop-chat-gateway
docker compose -f compose.example.yml up -d --build
rm -f "$archive"
