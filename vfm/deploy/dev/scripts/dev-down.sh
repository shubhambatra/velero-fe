#!/usr/bin/env bash
# Tear down the VFM local development environment.
#
#   ./scripts/dev-down.sh                  everything this directory owns
#   ./scripts/dev-down.sh --compose-only
#   ./scripts/dev-down.sh --clusters-only
#   ./scripts/dev-down.sh --cluster vfm-a
#   ./scripts/dev-down.sh --keep-volumes   stop compose but keep the data
#
# Deletes exactly two things:
#   * the kind clusters vfm-a and vfm-b
#   * the `vfm-dev` compose project, including its named volumes
#
# It will NOT touch any other kind cluster on this machine. Every cluster name
# passes through assert_owned_cluster first, so a cluster such as `kind-velero`
# can never be deleted here even if it is passed on the command line.
#
# Idempotent: with nothing running it reports what was already absent and exits
# zero.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DO_COMPOSE=1
DO_CLUSTERS=1
KEEP_VOLUMES=0
KEEP_GENERATED=0
TARGET_CLUSTERS=("${VFM_DEV_CLUSTERS[@]}")

while (( $# )); do
  case "$1" in
    --compose-only)   DO_CLUSTERS=0; shift ;;
    --clusters-only)  DO_COMPOSE=0; shift ;;
    --keep-volumes)   KEEP_VOLUMES=1; shift ;;
    --keep-generated) KEEP_GENERATED=1; shift ;;
    --cluster)
      [[ -n "${2:-}" ]] || die "--cluster needs a name"
      assert_owned_cluster "$2"
      TARGET_CLUSTERS=("$2"); DO_COMPOSE=0; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_env
require_docker

# Report, before deleting anything, which clusters on this machine are being
# left alone. Being explicit about it is the point.
report_untouched_clusters() {
  local all other=()
  all="$(kind get clusters 2>/dev/null || true)"
  [[ -n "${all}" ]] || return 0
  local name owned keep
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    keep=1
    for owned in "${TARGET_CLUSTERS[@]}"; do
      [[ "${name}" == "${owned}" ]] && keep=0
    done
    (( keep )) && other+=("${name}")
  done <<<"${all}"
  if (( ${#other[@]} )); then
    log "leaving untouched: ${other[*]}"
  fi
}

delete_clusters() {
  step "kind clusters"
  report_untouched_clusters

  local cluster
  for cluster in "${TARGET_CLUSTERS[@]}"; do
    # Belt and braces: the flag parser already checked, check again at the
    # point of deletion.
    assert_owned_cluster "${cluster}"

    if ! kind_cluster_exists "${cluster}"; then
      skip "cluster ${cluster} is absent"
      # A context can outlive its cluster if the cluster was deleted by hand.
      local ctx; ctx="$(kube_ctx "${cluster}")"
      if kube_context_exists "${ctx}"; then
        log "removing stale kubectl context ${ctx}"
        kubectl config delete-context "${ctx}" >/dev/null 2>&1 || true
        kubectl config delete-cluster "${ctx}" >/dev/null 2>&1 || true
        kubectl config delete-user "${ctx}" >/dev/null 2>&1 || true
      fi
      continue
    fi

    log "deleting kind cluster ${cluster}"
    kind delete cluster --name "${cluster}" \
      || die "failed to delete kind cluster ${cluster}" \
             "Retry: kind delete cluster --name ${cluster}"
    ok "cluster ${cluster} deleted"
  done
}

delete_compose() {
  step "docker compose project ${VFM_DEV_COMPOSE_PROJECT}"

  local running
  running="$(compose ps --all --quiet 2>/dev/null | grep -c . || true)"
  if [[ "${running}" == "0" ]]; then
    skip "no containers in project ${VFM_DEV_COMPOSE_PROJECT}"
  fi

  local -a args=(down --remove-orphans)
  if (( KEEP_VOLUMES )); then
    log "keeping named volumes (--keep-volumes)"
  else
    args+=(--volumes)
  fi

  compose "${args[@]}" \
    || die "docker compose down failed" \
           "Retry: docker compose -p ${VFM_DEV_COMPOSE_PROJECT} --env-file ${VFM_DEV_ENV_FILE} -f ${VFM_DEV_COMPOSE_FILE} down --volumes"

  if (( KEEP_VOLUMES )); then
    ok "project stopped, volumes kept"
  else
    local leftovers
    leftovers="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${VFM_DEV_COMPOSE_PROJECT}" | grep -c . || true)"
    [[ "${leftovers}" == "0" ]] \
      && ok "project and volumes removed" \
      || warn "${leftovers} volume(s) of project ${VFM_DEV_COMPOSE_PROJECT} still exist; remove with: docker volume prune"
  fi
}

main() {
  if (( DO_CLUSTERS )); then
    delete_clusters
  else
    log "skipping kind clusters (--compose-only)"
  fi

  if (( DO_COMPOSE )); then
    delete_compose
  else
    log "skipping the compose project"
  fi

  # .generated/ only describes the environment that just went away. Keeping it
  # would leave a stale payload checksum lying around for the E2E suite to pick
  # up, which is worse than deleting it — dev-up.sh rebuilds it.
  if (( DO_CLUSTERS && DO_COMPOSE )) && [[ -d "${VFM_DEV_GENERATED_DIR}" ]]; then
    if (( KEEP_GENERATED )); then
      log "keeping ${VFM_DEV_GENERATED_DIR#"${VFM_DEV_DIR}/"} (--keep-generated)"
    else
      step "generated files"
      rm -rf "${VFM_DEV_GENERATED_DIR}"
      ok "removed ${VFM_DEV_GENERATED_DIR#"${VFM_DEV_DIR}/"}"
    fi
  fi

  step "Done"
  log "bring it back with: ./scripts/dev-up.sh"
  printf '\n'
}

main "$@"
