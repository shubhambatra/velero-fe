#!/usr/bin/env bash
# Puts the sample workloads (namespace demo with a PVC holding a known payload) back to their starting state and
# removes what the golden paths leave behind. Safe to run any time. The Velero/MinIO data is left alone.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="${VFM_KUBE_CONTEXT:-kind-vfm-a}"
for ns in demo demo-restored; do kubectl --context "$CTX" delete namespace "$ns" --ignore-not-found --wait=true --timeout=180s >/dev/null; done
VFM_DEV_SOLO=1 "$here/../deploy/dev/scripts/sample-workloads.sh" --cluster vfm-a 2>&1 | tail -2
rm -f "${VFM_E2E_STATE:-/tmp/vfm-e2e-state}/last-backup"
echo "sample workloads reset"
