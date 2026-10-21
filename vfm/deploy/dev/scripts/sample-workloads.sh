#!/usr/bin/env bash
# Apply the sample workloads in namespace `demo` and seed the PVC with data of
# known sha256 (PLAN.md §14.1; the checksum is what E2E golden path 3 compares
# against — PLAN.md §15).
#
#   ./scripts/sample-workloads.sh                  both clusters
#   ./scripts/sample-workloads.sh --cluster vfm-a  one cluster
#
# What lands in the cluster:
#   namespace demo
#     Deployment/nginx    2 replicas, stateless
#     StatefulSet/demo-data  1 replica with a 64Mi PVC on csi-hostpath-sc
#
# The payload file is written into the volume from here, not by the pod. If the
# pod seeded its own data at startup, golden path 3 ("delete namespace →
# restore → checksum matches") would pass even if the restore recovered nothing
# — the pod would just write the file again.
#
# The payload is derived from the cluster name alone, so it is identical on
# every run and re-running this script is a genuine no-op.
#
# Writes: .generated/<cluster>-demo-payload.txt
#         .generated/<cluster>-demo-payload.sha256

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET_CLUSTERS=("${VFM_DEV_CLUSTERS[@]}")

while (( $# )); do
  case "$1" in
    --cluster)
      [[ -n "${2:-}" ]] || die "--cluster needs a name"
      assert_owned_cluster "$2"
      TARGET_CLUSTERS=("$2"); shift 2 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_env
ensure_generated_dir

DEMO_NS="demo"
PAYLOAD_PATH="/data/payload.txt"

# generate_payload <cluster> <outfile> — deterministic fixture content.
generate_payload() {
  local cluster="$1" out="$2"
  {
    printf 'VFM dev fixture — do not edit\n'
    printf 'cluster: %s\n' "${cluster}"
    printf 'purpose: PLAN.md §15 E2E golden path 3 (restore → checksum matches)\n'
    printf -- '---\n'
    local i
    for i in $(seq 1 512); do
      printf 'line %04d  %s  deterministic payload for golden path 3\n' "${i}" "${cluster}"
    done
  } >"${out}"
}

seed_cluster() {
  local cluster="$1"
  local ctx; ctx="$(kube_ctx "${cluster}")"

  step "Sample workloads in ${cluster} (namespace ${DEMO_NS})"

  kube_context_exists "${ctx}" || die \
    "kubectl context ${ctx} does not exist" \
    "Create the cluster first: ./scripts/dev-up.sh --cluster ${cluster}"

  # The PVC needs the hostpath driver's StorageClass to exist, otherwise it
  # would sit Pending forever with a misleading message.
  kc "${ctx}" get storageclass csi-hostpath-sc >/dev/null 2>&1 || die \
    "StorageClass csi-hostpath-sc is missing in ${ctx}" \
    "The hostpath CSI driver is not installed. Run: ./scripts/dev-up.sh --cluster ${cluster}"

  log "applying manifests/sample-workloads/demo.yaml"
  kc "${ctx}" apply -f "${VFM_DEV_MANIFESTS_DIR}/sample-workloads/demo.yaml" | sed 's/^/    /'

  wait_rollout "${ctx}" "${DEMO_NS}" deployment/nginx 300
  wait_rollout "${ctx}" "${DEMO_NS}" statefulset/demo-data 420

  local pod="demo-data-0"
  local payload="${VFM_DEV_GENERATED_DIR}/${cluster}-demo-payload.txt"
  local shafile="${VFM_DEV_GENERATED_DIR}/${cluster}-demo-payload.sha256"

  generate_payload "${cluster}" "${payload}"
  local want; want="$(sha256sum "${payload}" | awk '{print $1}')"

  # What the volume holds right now (empty string if the file is absent).
  local have
  have="$(kc "${ctx}" -n "${DEMO_NS}" exec "${pod}" -c data -- \
            sh -c "sha256sum ${PAYLOAD_PATH} 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)"
  have="${have//[$'\r\n ']/}"

  if [[ "${have}" == "${want}" ]]; then
    skip "payload in ${pod}:${PAYLOAD_PATH}"
  else
    if [[ -n "${have}" ]]; then
      warn "payload checksum in ${pod} was ${have}, rewriting"
    fi
    log "writing ${PAYLOAD_PATH} into the PVC ($(wc -c <"${payload}") bytes)"
    kc "${ctx}" -n "${DEMO_NS}" exec -i "${pod}" -c data -- \
      sh -c "cat > ${PAYLOAD_PATH} && sync" <"${payload}" \
      || die "could not write the payload into ${pod}:${PAYLOAD_PATH} (${ctx})"
  fi

  # Read it back from inside the cluster and compare. This is the assertion —
  # the recorded checksum is worthless unless it is what the volume holds.
  local got
  got="$(kc "${ctx}" -n "${DEMO_NS}" exec "${pod}" -c data -- \
          sh -c "sha256sum ${PAYLOAD_PATH} | cut -d' ' -f1")"
  got="${got//[$'\r\n ']/}"
  [[ "${got}" == "${want}" ]] || die \
    "payload checksum mismatch in ${ctx}" \
    "expected (host):     ${want}" \
    "in-cluster (${pod}): ${got:-<none>}" \
    "The PVC did not take the write. Check the hostpath driver:" \
    "  kubectl --context ${ctx} -n default logs statefulset/csi-hostpathplugin -c hostpath"

  printf '%s  %s\n' "${want}" "${PAYLOAD_PATH}" >"${shafile}"
  ok "sha256 ${want}"
  ok "recorded in ${shafile#"${VFM_DEV_DIR}/"}"

  kc "${ctx}" -n "${DEMO_NS}" get pods,pvc -o wide | sed 's/^/    /'
}

for c in "${TARGET_CLUSTERS[@]}"; do
  seed_cluster "${c}"
done
