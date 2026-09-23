#!/bin/sh
set -eu

stamp='20260906-collection-contract'
service_image='soop-chat-gateway-soop-gateway:latest'
rollback_image="soop-chat-gateway-soop-gateway:rollback-${stamp}"
rollback_files="/opt/byeollog/backups/gateway-pre-${stamp}.tar.gz"
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'

test -f "$rollback_files"
docker image inspect "$rollback_image" >/dev/null
tar -xzf "$rollback_files" -C /opt/byeollog
docker tag "$rollback_image" "$service_image"
docker compose -f "$compose" up -d --no-build --force-recreate

attempt=0
until curl -fsS http://127.0.0.1:47631/healthz; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ]
  sleep 2
done
