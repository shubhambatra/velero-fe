#!/usr/bin/env bash
# Seeds the dev installation (PLAN.md section 14.1): a platform admin, two organizations, a user for each built-in
# role, and a cluster per organization. With --enroll it also installs the agent into the matching kind
# clusters (kind-vfm-a, kind-vfm-b) so they are connected.
#
#   ./scripts/seed.sh                    # rows only; prints the accounts and the bootstrap tokens
#   ./scripts/seed.sh --enroll           # also helm-install the agent into each kind cluster that exists
#
# Every account has the same password (SEED_PASSWORD, default Velero-dev-Seed-9); administrators and
# owners will be asked to enrol a second factor at first sign-in. Needs the server built (pnpm --filter @vfm/server
# build), DATABASE_URL / REDIS_URL / VFM_MASTER_KEY in the environment or server/.env, and for --enroll a control
# plane the clusters can reach: set VFM_GATEWAY_ADDRESS (host:port, default: the docker bridge gateway, port 8443)
# and list that host in GATEWAY_HOSTNAMES. Never run it against a real installation: it refuses NODE_ENV=production.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/../../.."
ENROLL=0; [[ "${1:-}" == "--enroll" ]] && ENROLL=1

[[ -f "$root/server/dist/seed.js" ]] || { echo "build the server first: pnpm --filter @vfm/server build" >&2; exit 2; }
if [[ -f "$root/server/.env" && -z "${DATABASE_URL:-}" ]]; then set -a; . <(grep -E '^(DATABASE_URL|REDIS_URL|VFM_MASTER_KEY)=' "$root/server/.env"); set +a; fi

out="$(cd "$root/server" && node dist/seed.js)"
printf '%s\n' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("password for every account:", d["password"])
for u in d["users"]: print("  ", u)
for c in d["clusters"]: print("   cluster", c["org"] + "/" + c["name"], "token:", c["bootstrapToken"] or "(already existed; use New token in the UI)")
'
(( ENROLL )) || exit 0

gw="${VFM_GATEWAY_ADDRESS:-$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9.]+$' | head -1):8443}"
ca="$(mktemp)"; trap 'rm -f "$ca"' EXIT
printf '%s\n' "$out" | python3 -c 'import sys, json; print(json.load(sys.stdin)["caPem"])' > "$ca"
echo "enrolling against $gw (the control plane must listen there and list its host in GATEWAY_HOSTNAMES)"
printf '%s\n' "$out" | python3 -c '
import sys, json
for c in json.load(sys.stdin)["clusters"]:
    if c["bootstrapToken"]: print(c["name"], c["bootstrapToken"])
' | while read -r name token; do
  ctx="kind-$name"
  kubectl config get-contexts "$ctx" >/dev/null 2>&1 || { echo "  $name: no kind context $ctx; skipped"; continue; }
  helm upgrade --install vfm-agent "$root/deploy/helm/vfm-agent" --kube-context "$ctx" -n vfm-system --create-namespace \
    --set controlPlane.address="$gw" --set-file controlPlane.caBundle="$ca" --set enrollment.token="$token" \
    --set image.repository=ghcr.io/shubhambatra/vfm-agent --set image.tag="${VFM_AGENT_TAG:-0.1.0}" --set image.pullPolicy=IfNotPresent >/dev/null
  echo "  $name: agent installed"
done
