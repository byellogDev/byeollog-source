#!/bin/sh
set -eu

service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image='soop-chat-gateway-soop-gateway:rollback-20260906-ready-fallback'
failed_image='soop-chat-gateway-soop-gateway:failed-20260906-ready-fallback'
rollback_files='/opt/byeollog/backups/gateway-pre-20260906-ready-fallback.tar.gz'
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'

docker image inspect "$rollback_image" >/dev/null
test -r "$rollback_files"
docker tag "$service_image" "$failed_image"
tar -xzf "$rollback_files" -C /opt/byeollog
docker tag "$rollback_image" "$service_image"
docker compose -f "$compose" up -d --no-build --force-recreate

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done
