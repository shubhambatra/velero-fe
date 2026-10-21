#!/usr/bin/env bash
# Verifies the control plane runs with NO route to the internet (PLAN.md P6, section 13 / R-125).
#
# Everything runs on a Docker network created with --internal, which has no gateway to the outside:
# PostgreSQL, Redis (with a password), the migration job, the control plane (read-only root filesystem,
# no capabilities, non-root, production mode), and then a driver that does first-run setup, MFA, creates an
# organization and a cluster, enrols an agent over mTLS, and reads the cluster back as CONNECTED.
#
#   ./verify-airgap.sh [image]       default: ghcr.io/shubhambatra/vfm-control-plane:0.1.0 (build it first)
#
# Needs only docker, and the images already present locally (nothing is pulled: that is the point).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${1:-ghcr.io/shubhambatra/vfm-control-plane:0.1.0}"
PG_IMAGE="${PG_IMAGE:-postgres:16.15-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-valkey/valkey:7.2.14-alpine}"
NET="vfm-airgap-$$"
RP="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
PGP="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
KEY="$(head -c 32 /dev/urandom | base64)"
DB="postgresql://vfm:${PGP}@pg:5432/vfm"
RURL="redis://:${RP}@redis:6379"
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 65532:65532)

for i in "$IMAGE" "$PG_IMAGE" "$REDIS_IMAGE"; do
  docker image inspect "$i" >/dev/null 2>&1 || { echo "image $i is not present locally; this script never pulls" >&2; exit 2; }
done

cleanup() { docker rm -f "$NET-pg" "$NET-redis" "$NET-cp" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
step() { printf '\n==> %s\n' "$*"; }
node_eval() { docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e "$1"; }

step "an internal network (no route out)"
docker network create --internal "$NET" >/dev/null
if docker run --rm --network "$NET" --entrypoint wget "$PG_IMAGE" -T 4 -q -O /dev/null http://1.1.1.1 2>/dev/null; then
  echo "FAIL: the network can reach the internet; the test would prove nothing" >&2; exit 1
fi
echo "  PASS  1.1.1.1 is unreachable from the network"
if docker run --rm --network "$NET" --entrypoint wget "$PG_IMAGE" -T 4 -q -O /dev/null http://example.com 2>/dev/null; then
  echo "FAIL: external DNS name resolved and answered" >&2; exit 1
fi
echo "  PASS  example.com is unreachable from the network"

step "PostgreSQL and Redis"
docker run -d --name "$NET-pg" --network "$NET" --network-alias pg -e POSTGRES_USER=vfm -e POSTGRES_PASSWORD="$PGP" -e POSTGRES_DB=vfm "$PG_IMAGE" >/dev/null
docker run -d --name "$NET-redis" --network "$NET" --network-alias redis "$REDIS_IMAGE" valkey-server --requirepass "$RP" >/dev/null
for _ in $(seq 1 60); do docker exec "$NET-pg" pg_isready -U vfm -d vfm >/dev/null 2>&1 && break; sleep 1; done
# The entrypoint restarts postgres once after init; wait for it to settle.
sleep 3; for _ in $(seq 1 60); do docker exec "$NET-pg" pg_isready -U vfm -d vfm >/dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 1 30); do docker exec "$NET-redis" valkey-cli -a "$RP" ping 2>/dev/null | grep -q PONG && break; sleep 1; done
echo "  ready"

step "migrations (the chart's pre-install Job, same flags)"
if ! out="$(docker run --rm --network "$NET" "${HARDEN[@]}" -e DATABASE_URL="$DB" -e HOME=/tmp -w /app --entrypoint node "$IMAGE" \
  node_modules/prisma/build/index.js migrate deploy 2>&1)"; then
  printf '%s\n' "$out" | head -40 >&2; echo "FAIL: the migration job failed" >&2; exit 1
fi
printf '%s\n' "$out" | tail -3
echo "  PASS  migrations applied"

step "production mode refuses a Redis with no password (threat model G-13)"
if docker run --rm --network "$NET" "${HARDEN[@]}" -e NODE_ENV=production -e DATABASE_URL="$DB" -e REDIS_URL="redis://redis:6379" -e VFM_MASTER_KEY="$KEY" "$IMAGE" >/tmp/airgap-g13.$$ 2>&1; then
  echo "FAIL: the server started without a Redis password" >&2; exit 1
fi
grep -q "REDIS_URL" /tmp/airgap-g13.$$ && ! grep -q "redis:6379" /tmp/airgap-g13.$$ && echo "  PASS  refused, naming REDIS_URL and not echoing the URL" || { cat /tmp/airgap-g13.$$; echo "FAIL: wrong refusal" >&2; exit 1; }
rm -f /tmp/airgap-g13.$$

step "the control plane (production, read-only, no capabilities)"
docker run -d --name "$NET-cp" --network "$NET" --network-alias cp "${HARDEN[@]}" \
  -e NODE_ENV=production -e HOST=0.0.0.0 -e LOG_LEVEL=info \
  -e DATABASE_URL="$DB" -e REDIS_URL="$RURL" -e VFM_MASTER_KEY="$KEY" \
  -e PUBLIC_URL=http://cp:3000 -e API_PUBLIC_URL=http://cp:3000 \
  -e GATEWAY_PUBLIC_ADDRESS=cp:8443 -e GATEWAY_HOSTNAMES=cp \
  "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if node_eval "fetch('http://cp:3000/readyz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { docker logs "$NET-cp" 2>&1 | tail -30; echo "FAIL: /readyz never returned 200" >&2; exit 1; }
echo "  PASS  /readyz is 200 (PostgreSQL and Redis reachable, no internet needed)"
docker exec "$NET-cp" node -e "fetch('http://localhost:9090/metrics').then(r=>r.text()).then(t=>process.exit(t.includes('vfm_')?0:1))" \
  && echo "  PASS  metrics answer on the separate port" || { echo "FAIL: no metrics on :9090" >&2; exit 1; }

step "an operator and an agent, end to end"
# The banner is inside a JSON log line, so its quotes are escaped: ... \"token\":\"<43 chars>\" ...
token="$(docker logs "$NET-cp" 2>&1 | sed -n 's/.*token\\":\\"\([A-Za-z0-9_-]*\)\\".*/\1/p' | head -1)"
[ -n "$token" ] || { docker logs "$NET-cp" 2>&1 | grep -i -A8 "no users yet" | head -14; echo "FAIL: could not find the setup token in the log" >&2; exit 1; }
docker run --rm --network "$NET" --entrypoint node -e SETUP_TOKEN="$token" -v "$here:/airgap:ro" "$IMAGE" /airgap/drive.js http://cp:3000 cp:8443

step "no secret in the log"
# The one-time setup token IS logged on purpose, only while no user exists (setup.service.ts); it must not
# appear anywhere else and must be useless once used. Everything else must never appear.
log="$(docker logs "$NET-cp" 2>&1)"
for pair in "database password:$PGP" "Redis password:$RP" "master key:$KEY"; do
  name="${pair%%:*}"; value="${pair#*:}"
  if printf '%s' "$log" | grep -F -- "$value" >/dev/null; then echo "FAIL: the $name appears in the control plane's log" >&2; exit 1; fi
  echo "  PASS  the $name is not in the log"
done
n="$(printf '%s' "$log" | grep -o -F -- "$token" | wc -l)"
if [ "$n" -ne 1 ]; then echo "FAIL: the setup token appears $n times in the log (expected exactly the one banner)" >&2; exit 1; fi
echo "  PASS  the setup token appears exactly once (the banner)"
echo "  error-level log lines: $(printf '%s\n' "$log" | grep -c '"level":50' || true)"

printf '\nAIR-GAP VERIFICATION PASSED (%s)\n' "$IMAGE"
