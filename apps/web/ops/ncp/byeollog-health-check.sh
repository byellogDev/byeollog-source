#!/bin/sh
set -eu

disk_percent="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
available_kib="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
total_kib="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
available_percent="$((available_kib * 100 / total_kib))"
container_state="$(docker inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' soop-chat-gateway-soop-gateway-1 2>/dev/null || printf 'missing:missing')"
outbox_dir='/var/lib/docker/volumes/soop-chat-gateway_soop-gateway-state/_data/outbox'
pending=0
dead_letters=0
if [ -d "$outbox_dir" ]; then
  pending="$(find "$outbox_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.dead-*.json' ! -name '*.corrupt-*' | wc -l)"
  dead_letters="$(find "$outbox_dir" -maxdepth 1 -type f -name '*.dead-*.json' | wc -l)"
fi

level='info'
if [ "$disk_percent" -ge 85 ] || [ "$available_percent" -le 10 ] || [ "$container_state" != 'running:healthy' ] || [ "$pending" -ge 5000 ]; then
  level='critical'
elif [ "$disk_percent" -ge 75 ] || [ "$available_percent" -le 20 ] || [ "$pending" -ge 100 ] || [ "$dead_letters" -gt 0 ]; then
  level='warning'
fi

logger -t byeollog-health "level=$level disk_percent=$disk_percent memory_available_percent=$available_percent container=$container_state outbox_pending=$pending outbox_dead_letters=$dead_letters"
[ "$level" != 'critical' ]
