#!/usr/bin/env bash
# Rehearses an upgrade with no downtime (PLAN.md section 13, R-123): the previous release serves traffic, the new
# release's migration runs underneath it, the new release starts beside it, the old one is stopped, and a probe
# makes a request every 50 ms through all of it. Data and an enrolled agent created under the OLD release must
# work under the NEW one.
#
#   ./build-previous.sh <ref>                      # once, builds vfm-control-plane:previous
#   ./verify-upgrade.sh [new-image] [old-image]
#
# Needs only docker and the images present locally. It uses an internal network (no internet).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW="${1:-ghcr.io/shubhambatra/vfm-control-plane:0.1.0}"
OLD="${2:-vfm-control-plane:previous}"
PG_IMAGE="${PG_IMAGE:-postgres:16.15-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-valkey/valkey:7.2.14-alpine}"
NET="vfm-upgrade-$$"; VOL="$NET-state"
RP="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
PGP="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
KEY="$(head -c 32 /dev/urandom | base64)"
DB="postgresql://vfm:${PGP}@pg:5432/vfm"; RURL="redis://:${RP}@redis:6379"
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user 65532:65532)
ENVS=(-e NODE_ENV=production -e HOST=0.0.0.0 -e LOG_LEVEL=info -e DATABASE_URL="$DB" -e REDIS_URL="$RURL" -e VFM_MASTER_KEY="$KEY"
      -e PUBLIC_URL=http://cp:3000 -e API_PUBLIC_URL=http://cp:3000 -e GATEWAY_PUBLIC_ADDRESS=cp:8443 -e GATEWAY_HOSTNAMES=cp)

for i in "$NEW" "$OLD" "$PG_IMAGE" "$REDIS_IMAGE"; do
  docker image inspect "$i" >/dev/null 2>&1 || { echo "image $i is not present locally (build the previous one with build-previous.sh)" >&2; exit 2; }
done
cleanup() { docker rm -f "$NET-pg" "$NET-redis" "$NET-old" "$NET-new" "$NET-probe" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
step() { printf '\n==> %s\n' "$*"; }
migrate() { docker run --rm --network "$NET" "${HARDEN[@]}" -e DATABASE_URL="$DB" -e HOME=/tmp -w /app --entrypoint node "$1" node_modules/prisma/build/index.js migrate deploy 2>&1; }
applied() { docker exec "$NET-pg" psql -U vfm -d vfm -Atc "select count(*) from _prisma_migrations where finished_at is not null"; }
ready() { # container-name
  for _ in $(seq 1 60); do
    docker run --rm --network "$NET" --entrypoint node "$NEW" -e "fetch('http://$1:3000/readyz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null && return 0; sleep 2
  done; docker logs "$1" 2>&1 | tail -20; return 1
}
drive() { # image mode args...
  local image="$1"; shift
  docker run --rm --network "$NET" --entrypoint node -v "$VOL:/state" -v "$here:/airgap:ro" -e SETUP_TOKEN="${token:-}" "$image" /airgap/upgrade-drive.js "$@"
}

step "infrastructure on an internal network"
docker network create --internal "$NET" >/dev/null; docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/state" --entrypoint sh "$PG_IMAGE" -c 'chmod 777 /state'
docker run -d --name "$NET-pg" --network "$NET" --network-alias pg -e POSTGRES_USER=vfm -e POSTGRES_PASSWORD="$PGP" -e POSTGRES_DB=vfm "$PG_IMAGE" >/dev/null
docker run -d --name "$NET-redis" --network "$NET" --network-alias redis "$REDIS_IMAGE" valkey-server --requirepass "$RP" >/dev/null
sleep 6; for _ in $(seq 1 60); do docker exec "$NET-pg" pg_isready -U vfm -d vfm >/dev/null 2>&1 && break; sleep 1; done

step "the PREVIOUS release: migrate, start, seed"
out="$(migrate "$OLD")" || { echo "$out" | head -30; echo "FAIL: the previous release's migrations" >&2; exit 1; }
before="$(applied)"; echo "  migrations applied by the previous release: $before"
docker run -d --name "$NET-old" --network "$NET" --network-alias cp "${HARDEN[@]}" "${ENVS[@]}" "$OLD" >/dev/null
ready "$NET-old" || { echo "FAIL: the previous release did not become ready" >&2; exit 1; }
token="$(docker logs "$NET-old" 2>&1 | sed -n 's/.*token\\":\\"\([A-Za-z0-9_-]*\)\\".*/\1/p' | head -1)"
[ -n "$token" ] || { echo "FAIL: no setup token in the previous release's log" >&2; exit 1; }
drive "$OLD" seed http://cp:3000 cp:8443

step "UPGRADE: a probe starts; the new migration runs under the old release; the new release joins; the old one leaves"
docker run -d --name "$NET-probe" --network "$NET" --entrypoint node -v "$VOL:/state" -v "$here:/airgap:ro" "$NEW" /airgap/upgrade-drive.js probe http://cp:3000 >/dev/null
sleep 2
out="$(migrate "$NEW")" || { echo "$out" | head -30; echo "FAIL: the new release's migrations" >&2; exit 1; }
after="$(applied)"
[ "$after" -gt "$before" ] || { echo "FAIL: the new release applied no migration ($before -> $after); the rehearsal proves nothing" >&2; exit 1; }
echo "  PASS  the new migration ran while the previous release was serving ($before -> $after applied)"
sleep 3   # the previous release keeps serving on the new schema
docker run -d --name "$NET-new" --network "$NET" --network-alias cp "${HARDEN[@]}" "${ENVS[@]}" "$NEW" >/dev/null
ready "$NET-new" || { echo "FAIL: the new release did not become ready" >&2; exit 1; }
echo "  PASS  the new release is ready beside the old one"
docker stop -t 30 "$NET-old" >/dev/null
sleep 3
docker run --rm -v "$VOL:/state" --entrypoint sh "$PG_IMAGE" -c 'touch /state/stop'
found=0
for _ in $(seq 1 30); do docker run --rm -v "$VOL:/state" --entrypoint sh "$PG_IMAGE" -c 'test -f /state/probe.json' && { found=1; break; }; sleep 1; done
if [ "$found" != 1 ]; then echo "--- probe container log:" >&2; docker logs "$NET-probe" 2>&1 | tail -20 >&2; echo "FAIL: the probe never reported" >&2; exit 1; fi
probe="$(docker run --rm -v "$VOL:/state" --entrypoint cat "$PG_IMAGE" /state/probe.json)"
total="$(printf '%s' "$probe" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
failed="$(printf '%s' "$probe" | { grep -o '"path"' || true; } | wc -l)"
echo "  probe: $total requests through the whole upgrade, $failed failed"
if [ "$failed" -ne 0 ]; then printf '%s\n' "$probe"; echo "FAIL: requests failed during the upgrade" >&2; exit 1; fi
[ "${total:-0}" -ge 100 ] || { echo "FAIL: the probe made only ${total:-0} requests, too few to mean anything" >&2; exit 1; }
echo "  PASS  no request failed"

step "the NEW release, alone, on what the old one left"
drive "$NEW" verify http://cp:3000 cp:8443
for c in old new; do
  n="$(docker logs "$NET-$c" 2>&1 | grep -c '"level":50' || true)"; echo "  error-level log lines in the $c release: $n"
done
printf '\nUPGRADE REHEARSAL PASSED (%s -> %s)\n' "$OLD" "$NEW"
