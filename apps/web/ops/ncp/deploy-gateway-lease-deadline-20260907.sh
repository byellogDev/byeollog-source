#!/bin/sh
set -eu

deploy_gateway() {
  archive="$1"
  expected="$2"
  [ -n "$expected" ]
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  [ "$actual" = "$expected" ]

  stamp='20260907-lease-deadline'
  service_image='soop-chat-gateway-soop-gateway:latest'
  rollback_image="soop-chat-gateway-soop-gateway:rollback-${stamp}"
  install_root="${BYEOLLOG_INSTALL_ROOT:-/opt/byeollog}"
  docker_cmd="${BYEOLLOG_DOCKER_CMD:-docker}"
  curl_cmd="${BYEOLLOG_CURL_CMD:-curl}"
  file_owner="${BYEOLLOG_FILE_OWNER:-root:root}"
  health_url="${BYEOLLOG_HEALTH_URL:-http://127.0.0.1:47631/healthz}"
  health_attempts="${BYEOLLOG_HEALTH_ATTEMPTS:-30}"
  health_sleep_seconds="${BYEOLLOG_HEALTH_SLEEP_SECONDS:-2}"
  post_health_sleep_seconds="${BYEOLLOG_POST_HEALTH_SLEEP_SECONDS:-5}"
  backup="${install_root}/backups/gateway-pre-${stamp}.tar.gz"
  compose="${install_root}/services/soop-chat-gateway/compose.example.yml"
  index_file="${install_root}/services/soop-chat-gateway/index.mjs"
  patched=0
  restarted=0

  run_docker() { "$docker_cmd" "$@"; }
  run_curl() { "$curl_cmd" "$@"; }

  rollback_on_failure() {
    exit_code=$?
    trap - EXIT HUP INT TERM
    if [ "$patched" -eq 1 ]; then
      tar -xzf "$backup" -C "$install_root" || true
      run_docker tag "$rollback_image" "$service_image" || true
      if [ "$restarted" -eq 1 ]; then
        run_docker compose -f "$compose" up -d --no-build --force-recreate || true
      fi
    fi
    exit "$exit_code"
  }
  trap rollback_on_failure EXIT HUP INT TERM

  install -d -m 700 "${install_root}/backups"
  tar -czf "$backup" -C "$install_root" services/soop-chat-gateway/index.mjs
  run_docker tag "$service_image" "$rollback_image"
  tar -xzf "$archive" -C "$install_root"
  chown "$file_owner" "$index_file"
  chmod 644 "$index_file"
  patched=1

  grep -Fq 'expiresAt-Date.now()>LEASE_REFRESH_SKEW_MS' "$index_file"
  grep -Fq 'activeLease.providerTokenExpiresAt||extra.tokenExpiresAt' "$index_file"
  grep -Fq 'token.providerTokenExpiresAt||token.expiresAt' "$index_file"
  if grep -Fq 'tokenExpiresAt:activeLease.expiresAt' "$index_file"; then exit 1; fi
  run_docker compose -f "$compose" build soop-gateway
  restarted=1
  run_docker compose -f "$compose" up -d --no-build --force-recreate

  attempt=0
  until run_curl -fsS "$health_url"; do
    attempt=$((attempt+1))
    if [ "$attempt" -ge "$health_attempts" ]; then return 1; fi
    sleep "$health_sleep_seconds"
  done

  sleep "$post_health_sleep_seconds"
  logs="$(run_docker logs --tail 200 soop-chat-gateway-soop-gateway-1 2>&1)"
  printf '%s\n' "$logs" | grep -Fq '"event":"gateway_started"'
  if printf '%s\n' "$logs" | grep -Eq '"event":"(workspace_crashed|reconcile_failed)"'; then exit 1; fi

  patched=0
  restarted=0
  trap - EXIT HUP INT TERM
  rm -f "$archive"
}

run_isolated_self_test() {
  test_root="$(mktemp -d)"
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM
  install_root="${test_root}/install"
  bin_root="${test_root}/bin"
  install -d "${install_root}/services/soop-chat-gateway" "$bin_root"
  printf '%s\n' 'ORIGINAL_GATEWAY' >"${install_root}/services/soop-chat-gateway/index.mjs"
  printf '%s\n' 'services: {}' >"${install_root}/services/soop-chat-gateway/compose.example.yml"

  cat >"${bin_root}/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$BYEOLLOG_TEST_DOCKER_LOG"
if [ "$1" = logs ]; then printf '%s\n' '{"event":"gateway_started"}'; fi
EOF
  cat >"${bin_root}/curl-fail" <<'EOF'
#!/bin/sh
exit 1
EOF
  cat >"${bin_root}/curl-ok" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod 700 "${bin_root}/docker" "${bin_root}/curl-fail" "${bin_root}/curl-ok"

  patch_root="${test_root}/patch/services/soop-chat-gateway"
  install -d "$patch_root"
  cat >"${patch_root}/index.mjs" <<'EOF'
const leaseFresh = expiresAt-Date.now()>LEASE_REFRESH_SKEW_MS;
const providerExpiry = activeLease.providerTokenExpiresAt||extra.tokenExpiresAt;
const tokenExpiry = token.providerTokenExpiresAt||token.expiresAt;
EOF
  archive="${test_root}/gateway.tar.gz"
  tar -czf "$archive" -C "${test_root}/patch" services/soop-chat-gateway/index.mjs
  expected="$(sha256sum "$archive" | awk '{print $1}')"
  export BYEOLLOG_INSTALL_ROOT="$install_root"
  export BYEOLLOG_DOCKER_CMD="${bin_root}/docker"
  export BYEOLLOG_TEST_DOCKER_LOG="${test_root}/docker.log"
  export BYEOLLOG_FILE_OWNER="$(id -u):$(id -g)"
  export BYEOLLOG_HEALTH_ATTEMPTS=1
  export BYEOLLOG_HEALTH_SLEEP_SECONDS=0
  export BYEOLLOG_POST_HEALTH_SLEEP_SECONDS=0

  export BYEOLLOG_CURL_CMD="${bin_root}/curl-fail"
  if (deploy_gateway "$archive" "$expected"); then
    echo 'rollback drill unexpectedly succeeded' >&2
    exit 1
  fi
  grep -Fxq 'ORIGINAL_GATEWAY' "${install_root}/services/soop-chat-gateway/index.mjs"
  [ "$(grep -c 'compose .* up -d --no-build --force-recreate' "${test_root}/docker.log")" -eq 2 ]

  : >"${test_root}/docker.log"
  tar -czf "$archive" -C "${test_root}/patch" services/soop-chat-gateway/index.mjs
  expected="$(sha256sum "$archive" | awk '{print $1}')"
  export BYEOLLOG_CURL_CMD="${bin_root}/curl-ok"
  deploy_gateway "$archive" "$expected"
  grep -Fq 'expiresAt-Date.now()>LEASE_REFRESH_SKEW_MS' "${install_root}/services/soop-chat-gateway/index.mjs"
  [ ! -e "$archive" ]
  printf '%s\n' 'PASS isolated rollback and success deployment drill'
  rm -rf "$test_root"
  trap - EXIT HUP INT TERM
}

if [ "${1:-}" = '--self-test' ]; then
  run_isolated_self_test
  exit 0
fi

archive="${1:-/tmp/gateway-lease-deadline-20260907.tar.gz}"
expected="${2:-}"
deploy_gateway "$archive" "$expected"
