#!/bin/sh
set -eu
# Caller must first confirm all connected accounts are waiting_for_live in DB.
# No queue file is deleted or rewritten by this deployment.
sudo -n sh -s <<'SH'
set -eu
name='soop-chat-gateway-soop-gateway-1'
compose='/opt/byeollog/services/soop-chat-gateway/compose.example.yml'
old='sha256:7fb72640f8855674ed13b7aa0a73331d2a256d7b0469856edddddf4c7c2ef17a'
[ "$(docker inspect --format '{{.Image}}' "$name")" = "$old" ]
[ "$(find /var/lib/docker/volumes/soop-chat-gateway_soop-gateway-state/_data/outbox -maxdepth 1 -type f -name '*.json' | wc -l)" -eq 0 ]
if docker logs --since 60s "$name" 2>&1 | grep -Eq '"event":"(sdk_connected|outbox_item_queued)"'; then echo 'Recent connection/event; activation held';exit 3;fi
backup='/opt/byeollog/backups/infra-pre-20260909'
mkdir -p "$backup"
[ ! -f "$backup/compose.yml" ]
cp "$compose" "$backup/compose.yml"
tar -czf "$backup/source.tar.gz" -C /opt/byeollog services/soop-chat-gateway/index.mjs services/soop-chat-gateway/outbox.mjs services/soop-chat-gateway/workspace-event-sequencer.mjs
cp /usr/local/sbin/byeollog-health-check "$backup/health-check"
docker tag "$old" soop-chat-gateway-soop-gateway:rollback-infra-20260909
rollback(){ code=$?;trap - EXIT HUP INT TERM;cp "$backup/compose.yml" "$compose";tar -xzf "$backup/source.tar.gz" -C /opt/byeollog;docker tag soop-chat-gateway-soop-gateway:rollback-infra-20260909 soop-chat-gateway-soop-gateway:latest;docker compose -f "$compose" up -d --no-build --force-recreate;exit "$code"; }
trap rollback EXIT HUP INT TERM
python3 - "$compose" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text();assert s.count('    pids_limit: 256')==1;assert 'logging:' not in s
s=s.replace('    pids_limit: 256','    pids_limit: 256\n    stop_grace_period: 120s\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "5"')
p.write_text(s)
PY
for f in index.mjs outbox.mjs workspace-event-sequencer.mjs; do cp "/opt/byeollog/infra-20260909/services/soop-chat-gateway/$f" "/opt/byeollog/services/soop-chat-gateway/$f";done
docker tag soop-chat-gateway-soop-gateway:infra-20260909 soop-chat-gateway-soop-gateway:latest
docker compose -f "$compose" config --quiet
docker compose -f "$compose" up -d --no-build --force-recreate
attempt=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' "$name")" = 'healthy' ];do attempt=$((attempt+1));[ "$attempt" -lt 30 ];sleep 2;done
docker exec "$name" node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/var/lib/byeollog/worker-state.json"));if(!Array.isArray(s.channels)||!s.queue||s.queue.pending!==0)process.exit(1);console.log(JSON.stringify({queue:s.queue.pending,channels:s.channels.length,status:s.status}));'
install -m 755 /opt/byeollog/infra-20260909/ops/ncp/infra-health.py /usr/local/sbin/byeollog-infra-health
printf '%s\n' '#!/bin/sh' 'exec /usr/local/sbin/byeollog-infra-health' > /usr/local/sbin/byeollog-health-check
chmod 755 /usr/local/sbin/byeollog-health-check
trap - EXIT HUP INT TERM
/usr/local/sbin/byeollog-health-check
echo 'Infra collector activated; rollback image and source retained'
SH
