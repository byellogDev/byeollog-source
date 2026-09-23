#!/bin/sh
set -eu

service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image='soop-chat-gateway-soop-gateway:rollback-20260905-sequencer-guard'
failed_image='soop-chat-gateway-soop-gateway:failed-20260905-sequencer-guard'
rollback_files='/opt/byeollog/backups/gateway-pre-20260905-sequencer-guard.tar.gz'
current_files='/opt/byeollog/backups/gateway-before-rollback-20260905-sequencer-guard.tar.gz'

docker image inspect "$rollback_image" >/dev/null
test -r "$rollback_files"

tar -czf "$current_files" \
  -C /opt/byeollog \
  services/soop-chat-gateway/index.mjs \
  services/soop-chat-gateway/workspace-event-sequencer.mjs
docker tag "$service_image" "$failed_image"
tar -xzf "$rollback_files" -C /opt/byeollog
docker tag "$rollback_image" "$service_image"

cd /opt/byeollog/services/soop-chat-gateway
docker compose -f compose.example.yml up -d --no-build --force-recreate

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 60 ]; then
    tar -xzf "$current_files" -C /opt/byeollog
    docker tag "$failed_image" "$service_image"
    docker compose -f compose.example.yml up -d --no-build --force-recreate
    exit 1
  fi
  sleep 2
done
