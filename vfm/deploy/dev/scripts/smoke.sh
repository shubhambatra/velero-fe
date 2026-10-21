#!/usr/bin/env bash
# M0 exit criterion: a Velero backup, created through the CLI, reaches phase
# Completed on every dev kind cluster (PLAN.md §16, M0 exit criteria).
#
#   ./scripts/smoke.sh                  both clusters
#   ./scripts/smoke.sh --cluster vfm-a  one cluster
#   ./scripts/smoke.sh --keep           do not delete the backup afterwards
#
# This script ASSERTS. It is not a report:
#   * the Backup must end in phase Completed — any other terminal phase, or no
#     terminal phase inside the timeout, exits non-zero
#   * at least one PodVolumeBackup must have Completed, which is what proves
#     the node agent actually performed a filesystem backup of the PVC rather
#     than the backup merely skipping it
# `velero backup describe --details` is printed either way.
#
# Backup names include a timestamp, so repeated runs never collide.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET_CLUSTERS=("${VFM_DEV_CLUSTERS[@]}")
KEEP_BACKUP=0
BACKUP_TIMEOUT="${VFM_SMOKE_TIMEOUT:-600}"
DEMO_NS="demo"

while (( $# )); do
  case "$1" in
    --cluster)
      [[ -n "${2:-}" ]] || die "--cluster needs a name"
      assert_owned_cluster "$2"
      TARGET_CLUSTERS=("$2"); shift 2 ;;
    --keep) KEEP_BACKUP=1; shift ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_env

require_tool kubectl "https://kubernetes.io/docs/tasks/tools/"
require_tool velero "https://velero.io/docs/v1.18/basic-install/#install-the-cli"

# Phases a Backup can finish in. Anything else means "still working".
is_terminal_phase() {
  case "$1" in
    Completed|PartiallyFailed|Failed|FailedValidation) return 0 ;;
    *) return 1 ;;
  esac
}

backup_phase() {
  local ctx="$1" name="$2"
  kc "${ctx}" -n velero get backup "${name}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true
}

smoke_cluster() {
  local cluster="$1"
  local ctx; ctx="$(kube_ctx "${cluster}")"
  local name="vfm-smoke-${cluster}-$(date -u +%Y%m%d-%H%M%S)"

  step "Smoke backup on ${cluster} (context ${ctx})"

  kube_context_exists "${ctx}" || die \
    "kubectl context ${ctx} does not exist" \
    "Bring the environment up first: ./scripts/dev-up.sh"
  kc "${ctx}" -n velero get deployment velero >/dev/null 2>&1 || die \
    "Velero is not installed in ${ctx}" \
    "Run: ./scripts/dev-up.sh --cluster ${cluster}"
  kc "${ctx}" -n "${DEMO_NS}" get statefulset demo-data >/dev/null 2>&1 || die \
    "the sample workloads are missing from ${ctx}" \
    "Run: ./scripts/sample-workloads.sh --cluster ${cluster}"

  local bsl_phase; bsl_phase="$(kc "${ctx}" -n velero get backupstoragelocation default \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [[ "${bsl_phase}" == "Available" ]] || die \
    "BackupStorageLocation 'default' in ${ctx} is '${bsl_phase:-<unset>}', not Available" \
    "Velero cannot reach MinIO. Check:" \
    "  kubectl --context ${ctx} -n velero logs deployment/velero | tail -50" \
    "  docker compose -p ${VFM_DEV_COMPOSE_PROJECT} ps"
  ok "BackupStorageLocation default is Available"

  # --default-volumes-to-fs-backup exercises the node agent (kopia) on the
  # demo-data PVC. The server was installed without that default so that each
  # backup states its own intent.
  log "velero backup create ${name} --include-namespaces ${DEMO_NS} --default-volumes-to-fs-backup"
  velero backup create "${name}" \
    --kubecontext "${ctx}" \
    --include-namespaces "${DEMO_NS}" \
    --default-volumes-to-fs-backup \
    --wait=false \
    || die "velero backup create failed on ${cluster}"

  # Poll for a terminal phase rather than trusting --wait, so the timeout and
  # the assertion are ours.
  local deadline=$(( SECONDS + BACKUP_TIMEOUT ))
  local phase=''
  printf '    polling backup phase '
  while (( SECONDS < deadline )); do
    phase="$(backup_phase "${ctx}" "${name}")"
    if is_terminal_phase "${phase}"; then
      printf ' %s\n' "${phase}"
      break
    fi
    printf '.'
    sleep 5
  done

  if ! is_terminal_phase "${phase}"; then
    printf ' timeout\n'
    velero backup describe "${name}" --kubecontext "${ctx}" --details || true
    die "backup ${name} on ${cluster} never reached a terminal phase within ${BACKUP_TIMEOUT}s" \
        "last observed phase: ${phase:-<unset>}" \
        "logs: velero backup logs ${name} --kubecontext ${ctx}"
  fi

  printf '\n%s--- velero backup describe %s --details ---%s\n' "${_c_dim}" "${name}" "${_c_reset}"
  velero backup describe "${name}" --kubecontext "${ctx}" --details || true
  printf '%s--- end describe ---%s\n\n' "${_c_dim}" "${_c_reset}"

  # ---- assertion 1: the phase ----------------------------------------------
  if [[ "${phase}" != "Completed" ]]; then
    printf '%s--- velero backup logs %s (tail) ---%s\n' "${_c_dim}" "${name}" "${_c_reset}" >&2
    velero backup logs "${name}" --kubecontext "${ctx}" 2>&1 | tail -60 >&2 || true
    die "backup ${name} on ${cluster} finished in phase ${phase}, expected Completed" \
        "This is the M0 exit criterion (PLAN.md §16), so it is a hard failure." \
        "The describe output and backup log tail are above."
  fi
  ok "backup ${name} phase=Completed"

  # ---- assertion 2: the node agent really backed the volume up -------------
  local pvb_total pvb_completed
  pvb_total="$(kc "${ctx}" -n velero get podvolumebackups \
    -l velero.io/backup-name="${name}" -o name 2>/dev/null | wc -l | tr -d ' ')"
  pvb_completed="$(kc "${ctx}" -n velero get podvolumebackups \
    -l velero.io/backup-name="${name}" \
    -o jsonpath='{range .items[?(@.status.phase=="Completed")]}{.metadata.name}{"\n"}{end}' \
    2>/dev/null | grep -c . || true)"

  if [[ "${pvb_total}" == "0" ]]; then
    kc "${ctx}" -n velero get podvolumebackups >&2 || true
    die "backup ${name} produced no PodVolumeBackup at all on ${cluster}" \
        "Namespace ${DEMO_NS} holds a PVC and the backup was created with" \
        "--default-volumes-to-fs-backup, so the node agent should have backed it up." \
        "Check: kubectl --context ${ctx} -n velero logs daemonset/node-agent | tail -50"
  fi
  if (( pvb_completed < 1 )); then
    kc "${ctx}" -n velero get podvolumebackups \
      -l velero.io/backup-name="${name}" \
      -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,POD:.spec.pod.name' >&2 || true
    die "none of the ${pvb_total} PodVolumeBackup(s) for ${name} Completed on ${cluster}" \
        "Check: kubectl --context ${ctx} -n velero logs daemonset/node-agent | tail -50"
  fi
  ok "${pvb_completed}/${pvb_total} PodVolumeBackup(s) Completed (filesystem backup via node-agent)"

  local items
  items="$(kc "${ctx}" -n velero get backup "${name}" \
    -o jsonpath='{.status.progress.itemsBackedUp}' 2>/dev/null || true)"
  ok "items backed up: ${items:-unknown}"

  if (( KEEP_BACKUP )); then
    log "keeping backup ${name} (--keep)"
  else
    log "deleting backup ${name}"
    velero backup delete "${name}" --kubecontext "${ctx}" --confirm >/dev/null 2>&1 || \
      warn "could not delete backup ${name}; remove it with: velero backup delete ${name} --kubecontext ${ctx} --confirm"
  fi

  SMOKE_RESULTS+=("${cluster}: Completed (${pvb_completed}/${pvb_total} PVB, items=${items:-?})")
}

SMOKE_RESULTS=()
for c in "${TARGET_CLUSTERS[@]}"; do
  smoke_cluster "${c}"
done

step "Smoke result"
for line in "${SMOKE_RESULTS[@]}"; do
  ok "${line}"
done
printf '\n    %sM0 exit criterion met: velero backup Completed on %d cluster(s).%s\n\n' \
  "${_c_green}" "${#SMOKE_RESULTS[@]}" "${_c_reset}"
