#!/usr/bin/env bash
# The control plane for the real end-to-end run: PostgreSQL, Redis and the control-plane IMAGE (production mode,
# read-only, no capabilities) on the docker network the kind cluster lives on, so the real agent inside the
# cluster dials it by name:  vfm-cp:8443.
#
#   ./stack.sh up            start (idempotent); prints the one-time setup token on a fresh database
#   ./stack.sh replica       start a second control-plane replica behind the same name (for replica-loss tests)
#   ./stack.sh down          remove everything this script created
#   ./stack.sh env           print the endpoints as shell exports
#
# Needs: docker, the kind cluster's network ("kind"), the images present locally.
set -euo pipefail
IMAGE="${VFM_CP_IMAGE:-ghcr.io/shubhambatra/vfm-control-plane:0.1.0}"
PG_IMAGE="${PG_IMAGE:-postgres:16.15-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-valkey/valkey:7.2.14-alpine}"
NET="${KIND_NETWORK:-kind}"
P=vfm-e2e
STATE="${VFM_E2E_STATE:-/tmp/vfm-e2e-state}"
mkdir -p "$STATE"
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 65532:65532)

secret() { # name -> a value persisted across runs of this script
  [ -s "$STATE/$1" ] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$STATE/$1"; cat "$STATE/$1"
}
master_key() { [ -s "$STATE/master-key" ] || head -c 32 /dev/urandom | base64 > "$STATE/master-key"; cat "$STATE/master-key"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }
gateway_ip() { docker network inspect "$NET" -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1; }

# CP_ENV is rebuilt by env_args (secrets are read from $STATE, so this is a function, not a constant).
env_args() {
  CP_ENV=(
    -e NODE_ENV=production -e HOST=0.0.0.0 -e LOG_LEVEL=info
    -e "DATABASE_URL=postgresql://vfm:$(secret pg)@$P-pg:5432/vfm"
    -e "REDIS_URL=redis://:$(secret redis)@$P-redis:6379"
    -e "VFM_MASTER_KEY=$(master_key)"
    -e PUBLIC_URL=http://127.0.0.1:3200 -e API_PUBLIC_URL=http://127.0.0.1:3200
    -e GATEWAY_PUBLIC_ADDRESS=vfm-cp:8443 -e GATEWAY_HOSTNAMES=vfm-cp,localhost,127.0.0.1
    -e ALERT_WEBHOOK_ALLOW_PRIVATE=true -e ALERT_WEBHOOK_ALLOW_HTTP=true
    -e ALERT_EVAL_INTERVAL_SECONDS=5 -e GATEWAY_ENROLL_PER_MINUTE=1000
  )
}

wait_ready() { # container host-port
  for _ in $(seq 1 90); do curl -fsS "http://127.0.0.1:$2/readyz" >/dev/null 2>&1 && return 0; sleep 1; done
  docker logs "$1" 2>&1 | tail -30; echo "FAIL: $1 never became ready" >&2; return 1
}

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || { echo "no docker network '$NET': create the kind cluster first (VFM_DEV_SOLO=1 deploy/dev/scripts/dev-up.sh --clusters-only)" >&2; exit 2; }
  running "$P-pg" || { docker rm -f "$P-pg" >/dev/null 2>&1 || true
    docker run -d --name "$P-pg" --network "$NET" -e POSTGRES_USER=vfm -e POSTGRES_PASSWORD="$(secret pg)" -e POSTGRES_DB=vfm "$PG_IMAGE" >/dev/null; }
  running "$P-redis" || { docker rm -f "$P-redis" >/dev/null 2>&1 || true
    docker run -d --name "$P-redis" --network "$NET" "$REDIS_IMAGE" valkey-server --requirepass "$(secret redis)" >/dev/null; }
  sleep 6; for _ in $(seq 1 60); do docker exec "$P-pg" pg_isready -U vfm -d vfm >/dev/null 2>&1 && break; sleep 1; done
  docker run --rm --network "$NET" "${HARDEN[@]}" -e "DATABASE_URL=postgresql://vfm:$(secret pg)@$P-pg:5432/vfm" -e HOME=/tmp -w /app --entrypoint node "$IMAGE" \
    node_modules/prisma/build/index.js migrate deploy 2>&1 | tail -2
  if ! running "$P-cp1"; then
    docker rm -f "$P-cp1" >/dev/null 2>&1 || true
    env_args
    docker run -d --name "$P-cp1" --network "$NET" --network-alias vfm-cp "${HARDEN[@]}" "${CP_ENV[@]}" \
      -p 127.0.0.1:3200:3000 -p 127.0.0.1:18443:8443 -p 127.0.0.1:19090:9090 "$IMAGE" >/dev/null
  fi
  wait_ready "$P-cp1" 3200
  echo "control plane ready: http://127.0.0.1:3200   gateway (in the cluster network): vfm-cp:8443"
  local token; token="$(docker logs "$P-cp1" 2>&1 | sed -n 's/.*token\\":\\"\([A-Za-z0-9_-]*\)\\".*/\1/p' | head -1)"
  if [ -n "$token" ]; then echo "$token" > "$STATE/setup-token"; echo "setup token saved to $STATE/setup-token"; fi
}

replica() {
  running "$P-cp2" && { echo "replica already running"; return; }
  docker rm -f "$P-cp2" >/dev/null 2>&1 || true
  env_args
  docker run -d --name "$P-cp2" --network "$NET" --network-alias vfm-cp "${HARDEN[@]}" "${CP_ENV[@]}" \
    -p 127.0.0.1:3201:3000 "$IMAGE" >/dev/null
  wait_ready "$P-cp2" 3201; echo "replica ready: http://127.0.0.1:3201"
}

down() { docker rm -f "$P-cp1" "$P-cp2" "$P-pg" "$P-redis" >/dev/null 2>&1 || true; rm -rf "$STATE"; echo "removed"; }

case "${1:-}" in
  up) up ;;
  replica) replica ;;
  down) down ;;
  env) echo "export VFM_API=http://127.0.0.1:3200 VFM_STATE=$STATE VFM_GATEWAY_IN_CLUSTER=vfm-cp:8443 VFM_HOST_GATEWAY_IP=$(gateway_ip)" ;;
  *) echo "usage: $0 up|replica|down|env" >&2; exit 2 ;;
esac
