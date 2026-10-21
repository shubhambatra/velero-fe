#!/usr/bin/env bash
# Shared helpers for the VFM dev-environment scripts.
#
# Sourced, never executed. Every caller starts with:
#   set -euo pipefail
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Design rules, from PLAN.md §0 rule 7 (no fake completeness):
#   * nothing here ever swallows a failure
#   * every wait has a timeout and prints diagnostics before it dies
#   * every idempotency guard reports what it skipped out loud rather than
#     silently doing nothing
#
# `make` is not required and not used: these scripts are the entry points.
# vfm/Makefile's dev-up / dev-down / smoke targets just call them.

# --- layout ------------------------------------------------------------------

VFM_DEV_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VFM_DEV_DIR="$(cd "${VFM_DEV_SCRIPTS_DIR}/.." && pwd)"
VFM_DEV_MANIFESTS_DIR="${VFM_DEV_DIR}/manifests"
VFM_DEV_GENERATED_DIR="${VFM_DEV_DIR}/.generated"
VFM_DEV_COMPOSE_FILE="${VFM_DEV_DIR}/docker-compose.yml"
VFM_DEV_ENV_FILE="${VFM_DEV_ENV_FILE:-${VFM_DEV_DIR}/dev.env}"
VFM_DEV_VERSIONS_FILE="${VFM_DEV_DIR}/versions.env"

# The compose project name. Hard-coded so this stack can never collide with
# another compose project on the same machine.
VFM_DEV_COMPOSE_PROJECT="vfm-dev"

# The clusters this directory owns. Anything not in this list is off limits —
# see assert_owned_cluster.
#
# VFM_DEV_SOLO=1 builds ONE single-node cluster (vfm-a) instead of two two-node ones. It exists for hosts
# whose inotify limits cannot be raised (blocker B-2): the distro default is enough for one node. The
# trade is that the second cluster, and so any test that needs two, is not there.
if [[ "${VFM_DEV_SOLO:-0}" == 1 ]]; then
  VFM_DEV_CLUSTERS=(vfm-a)
  # VFM_DEV_SOLO_B=1 adds a second single-node cluster (vfm-b) for multi-cluster work, if the host has the memory.
  [[ "${VFM_DEV_SOLO_B:-0}" == 1 ]] && VFM_DEV_CLUSTERS+=(vfm-b)
else
  VFM_DEV_CLUSTERS=(vfm-a vfm-b)
fi

# The docker network kind puts its nodes on.
VFM_DEV_KIND_NETWORK="kind"

# --- logging -----------------------------------------------------------------

if [[ -t 1 ]]; then
  _c_reset=$'\033[0m'; _c_bold=$'\033[1m'; _c_dim=$'\033[2m'
  _c_red=$'\033[31m'; _c_green=$'\033[32m'; _c_yellow=$'\033[33m'; _c_blue=$'\033[34m'
else
  _c_reset=''; _c_bold=''; _c_dim=''; _c_red=''; _c_green=''; _c_yellow=''; _c_blue=''
fi

_vfm_step_no=0

# step "Heading" — a numbered top-level phase.
step() {
  _vfm_step_no=$(( _vfm_step_no + 1 ))
  printf '\n%s==> [%d] %s%s\n' "${_c_bold}${_c_blue}" "${_vfm_step_no}" "$*" "${_c_reset}"
}

log()  { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "${_c_green}" "${_c_reset}" "$*"; }
skip() { printf '    %s•%s %s %s(nothing to do)%s\n' "${_c_green}" "${_c_reset}" "$*" "${_c_dim}" "${_c_reset}"; }
warn() { printf '    %s!%s %s\n' "${_c_yellow}" "${_c_reset}" "$*" >&2; }

# die "message" ["remedy line" ...] — loud, actionable, non-zero.
die() {
  local msg="$1"; shift || true
  printf '\n%sFATAL:%s %s\n' "${_c_bold}${_c_red}" "${_c_reset}" "${msg}" >&2
  local line
  for line in "$@"; do
    printf '  %s\n' "${line}" >&2
  done
  printf '\n' >&2
  exit 1
}

# --- configuration -----------------------------------------------------------

# load_env — read dev.env and versions.env into the environment.
load_env() {
  [[ -f "${VFM_DEV_ENV_FILE}" ]] \
    || die "dev env file not found: ${VFM_DEV_ENV_FILE}" \
           "It is committed; if it is missing the checkout is incomplete." \
           "Override the path with VFM_DEV_ENV_FILE=/path/to/your.env"
  [[ -f "${VFM_DEV_VERSIONS_FILE}" ]] \
    || die "version pin file not found: ${VFM_DEV_VERSIONS_FILE}"

  set -a
  # shellcheck disable=SC1090
  source "${VFM_DEV_ENV_FILE}"
  # shellcheck disable=SC1090
  source "${VFM_DEV_VERSIONS_FILE}"
  set +a

  local required=(
    VFM_DEV_POSTGRES_PORT VFM_DEV_VALKEY_PORT VFM_DEV_MINIO_API_PORT
    VFM_DEV_MINIO_CONSOLE_PORT VFM_DEV_MAILPIT_SMTP_PORT VFM_DEV_MAILPIT_UI_PORT
    VFM_DEV_DEX_PORT MINIO_ROOT_USER MINIO_ROOT_PASSWORD
    VFM_DEV_BUCKET_A VFM_DEV_BUCKET_B VFM_DEV_MINIO_REGION
    VFM_VELERO_VERSION VFM_VELERO_IMAGE VFM_VELERO_AWS_PLUGIN_IMAGE
    VFM_KIND_NODE_IMAGE
  )
  local var
  for var in "${required[@]}"; do
    [[ -n "${!var:-}" ]] || die "required setting ${var} is empty" \
      "Check ${VFM_DEV_ENV_FILE} and ${VFM_DEV_VERSIONS_FILE}."
  done
}

# bucket_for <cluster> — which MinIO bucket a cluster backs up to.
bucket_for() {
  case "$1" in
    vfm-a) printf '%s' "${VFM_DEV_BUCKET_A}" ;;
    vfm-b) printf '%s' "${VFM_DEV_BUCKET_B}" ;;
    *) die "no bucket mapping for cluster '$1'" ;;
  esac
}

# kube_ctx <cluster> — kind's kubectl context name for a cluster.
kube_ctx() { printf 'kind-%s' "$1"; }

# assert_owned_cluster <name> — refuse to act on any cluster this directory
# does not own. Unrelated kind clusters (notably `kind-velero` on the author's
# machine) must never be created, deleted or reconfigured by these scripts.
assert_owned_cluster() {
  local name="$1" owned
  for owned in "${VFM_DEV_CLUSTERS[@]}"; do
    [[ "${name}" == "${owned}" ]] && return 0
  done
  die "refusing to touch kind cluster '${name}'" \
      "These scripts only ever manage: ${VFM_DEV_CLUSTERS[*]}" \
      "Any other cluster on this machine belongs to someone else."
}

# --- prerequisites -----------------------------------------------------------

# require_tool <binary> <install hint>
require_tool() {
  local bin="$1" hint="${2:-}"
  command -v "${bin}" >/dev/null 2>&1 || die \
    "missing prerequisite: ${bin}" \
    "install: ${hint}"
}

require_docker() {
  require_tool docker "https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die \
    "the docker daemon is not reachable" \
    "Start it (systemctl --user start docker, or 'sudo systemctl start docker')" \
    "and check that your user is in the 'docker' group."
  docker compose version >/dev/null 2>&1 || die \
    "docker compose v2+ is not available" \
    "install: https://docs.docker.com/compose/install/"
}

# --- host ports --------------------------------------------------------------

# port_in_use <port> — 0 if something is listening on 127.0.0.1:<port>.
port_in_use() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

# port_owner <port> — name of the docker container publishing <port>, if any.
port_owner() {
  local port="$1"
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | awk -v p=":${port}->" 'index($0, p) { print $1; exit }'
}

# require_host_port <port> <what it is for> — the port must be either free or
# already held by this compose project (so re-running dev-up is fine).
require_host_port() {
  local port="$1" what="$2"
  port_in_use "${port}" || return 0

  local owner; owner="$(port_owner "${port}")"
  if [[ -n "${owner}" ]]; then
    local project
    project="$(docker inspect "${owner}" \
      --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    if [[ "${project}" == "${VFM_DEV_COMPOSE_PROJECT}" ]]; then
      return 0
    fi
    die "host port ${port} (${what}) is taken by container '${owner}'" \
        "That container belongs to compose project '${project:-<none>}', not ${VFM_DEV_COMPOSE_PROJECT}." \
        "Either stop it, or change the port in ${VFM_DEV_ENV_FILE}" \
        "(the port numbers there are the single source of truth)."
  fi
  die "host port ${port} (${what}) is already in use by a non-docker process" \
      "Find it with: ss -ltnp 'sport = :${port}'" \
      "Then stop it, or change the port in ${VFM_DEV_ENV_FILE}."
}

# --- compose -----------------------------------------------------------------

compose() {
  docker compose \
    --project-name "${VFM_DEV_COMPOSE_PROJECT}" \
    --project-directory "${VFM_DEV_DIR}" \
    --env-file "${VFM_DEV_ENV_FILE}" \
    --file "${VFM_DEV_COMPOSE_FILE}" \
    "$@"
}

# --- kind / kubectl ----------------------------------------------------------

kind_cluster_exists() {
  local name="$1"
  kind get clusters 2>/dev/null | grep -qxF "${name}"
}

kube_context_exists() {
  local ctx="$1"
  kubectl config get-contexts -o name 2>/dev/null | grep -qxF "${ctx}"
}

# kc <ctx> <kubectl args...>
kc() {
  local ctx="$1"; shift
  kubectl --context "${ctx}" "$@"
}

# --- waiting -----------------------------------------------------------------

# wait_for <timeout-seconds> <description> <command...>
# Polls the command every 3s until it succeeds. Dies with the command's last
# output on timeout.
wait_for() {
  local timeout="$1" desc="$2"; shift 2
  local deadline=$(( SECONDS + timeout ))
  local out=''
  printf '    waiting for %s ' "${desc}"
  while (( SECONDS < deadline )); do
    if out="$("$@" 2>&1)"; then
      printf ' %s✓%s\n' "${_c_green}" "${_c_reset}"
      return 0
    fi
    printf '.'
    sleep 3
  done
  printf ' %stimeout%s\n' "${_c_red}" "${_c_reset}"
  die "timed out after ${timeout}s waiting for ${desc}" \
      "last command: $*" \
      "last output: ${out:-<empty>}"
}

# wait_rollout <ctx> <namespace> <kind/name> [timeout-seconds]
wait_rollout() {
  local ctx="$1" ns="$2" target="$3" timeout="${4:-300}"
  log "waiting for rollout of ${target} in ${ns} (${ctx}, timeout ${timeout}s)"
  if ! kc "${ctx}" -n "${ns}" rollout status "${target}" --timeout="${timeout}s"; then
    printf '\n%s--- diagnostics: %s/%s in %s ---%s\n' \
      "${_c_dim}" "${ns}" "${target}" "${ctx}" "${_c_reset}" >&2
    kc "${ctx}" -n "${ns}" get pods -o wide >&2 || true
    kc "${ctx}" -n "${ns}" describe "${target}" >&2 || true
    kc "${ctx}" -n "${ns}" get events --sort-by=.lastTimestamp 2>&1 | tail -30 >&2 || true
    die "rollout of ${target} in namespace ${ns} (${ctx}) did not complete in ${timeout}s" \
        "The pod state and recent events are above."
  fi
  ok "${target} rolled out"
}

# wait_condition <ctx> <namespace|-> <resource> <condition> [timeout-seconds]
# Thin wrapper over `kubectl wait` that prints diagnostics on failure.
#
# <resource> may carry selector flags ("nodes --all"), so it is split on
# whitespace into separate arguments rather than passed as one token.
wait_condition() {
  local ctx="$1" ns="$2" resource="$3" condition="$4" timeout="${5:-300}"
  local -a nsargs=() res=()
  [[ "${ns}" != "-" ]] && nsargs=(-n "${ns}")
  read -r -a res <<<"${resource}"
  log "waiting for ${resource} to be ${condition} (${ctx}, timeout ${timeout}s)"
  if ! kc "${ctx}" "${nsargs[@]}" wait "${res[@]}" \
        --for="${condition}" --timeout="${timeout}s"; then
    printf '\n%s--- diagnostics: %s (%s) ---%s\n' \
      "${_c_dim}" "${resource}" "${ctx}" "${_c_reset}" >&2
    kc "${ctx}" "${nsargs[@]}" get "${res[@]}" -o wide >&2 || true
    kc "${ctx}" "${nsargs[@]}" describe "${res[@]}" >&2 || true
    die "${resource} did not become ${condition} within ${timeout}s in ${ctx}"
  fi
  ok "${resource} is ${condition}"
}

# --- misc --------------------------------------------------------------------

ensure_generated_dir() {
  mkdir -p "${VFM_DEV_GENERATED_DIR}"
  # .generated/ is gitignored (vfm/.gitignore: deploy/dev/.generated/), but
  # leave a note for anyone who finds the directory on its own.
  local note="${VFM_DEV_GENERATED_DIR}/README"
  [[ -f "${note}" ]] || cat >"${note}" <<'EOF'
Generated by deploy/dev/scripts/*.sh. Not committed (gitignored), safe to
delete: dev-up.sh recreates everything here. Holds the Velero MinIO credentials
file, rendered manifests, and the sha256 of each cluster's demo payload (which
the E2E golden paths compare against).
EOF
}

# require_inotify_limits — fail before building a cluster that cannot work.
#
# Every kind node runs a kubelet and a kube-proxy, and each consumes inotify
# instances and watches from a *host-wide* pool. The distro defaults (128
# instances) are enough for one single-node cluster and not for two two-node
# clusters: kube-proxy on the second node dies with "too many open files",
# every pod on that node then fails to reach any Service IP, and the symptom
# surfaces minutes later as an unrelated-looking rollout timeout.
#
# Checked here rather than discovered there. kind documents the same minimums.
require_inotify_limits() {
  local want_instances=512 want_watches=524288
  if [[ "${VFM_DEV_SOLO:-0}" == 1 ]]; then want_instances=128 want_watches=65536; fi
  local instances watches
  instances="$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)"
  watches="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)"

  if (( instances < want_instances || watches < want_watches )); then
    die "the host inotify limits are too low to run the kind clusters" \
        "" \
        "  fs.inotify.max_user_instances = ${instances} (need >= ${want_instances})" \
        "  fs.inotify.max_user_watches   = ${watches} (need >= ${want_watches})" \
        "" \
        "Raise them (needs root, and does not survive a reboot):" \
        "  sudo sysctl -w fs.inotify.max_user_instances=${want_instances}" \
        "  sudo sysctl -w fs.inotify.max_user_watches=${want_watches}" \
        "" \
        "To persist across reboots:" \
        "  echo -e 'fs.inotify.max_user_instances=${want_instances}\\nfs.inotify.max_user_watches=${want_watches}' \\\\" \
        "    | sudo tee /etc/sysctl.d/99-kind.conf && sudo sysctl --system" \
        "" \
        "Without this, kube-proxy on a worker node crash-loops with" \
        "'too many open files' and nothing on that node can reach a Service IP." \
        "See https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files"
  fi
  ok "inotify limits sufficient (instances ${instances}, watches ${watches})"
}

# minio_kind_ip — MinIO's address on the `kind` docker network.
#
# The compose stack publishes MinIO on 127.0.0.1 only, deliberately: binding it
# to every interface would expose dev credentials to the local network. That
# means a kind node cannot reach it through the bridge gateway, so the MinIO
# container is joined to the `kind` network as a second attachment and the
# clusters talk to it directly. The host publishing stays loopback-only.
#
# Idempotent: connecting an already-connected container is treated as success.
minio_kind_ip() {
  local name="${VFM_DEV_COMPOSE_PROJECT}-minio" ip

  docker container inspect "${name}" >/dev/null 2>&1 || die \
    "the MinIO container ${name} is not running" \
    "The compose stack must be up before the kind clusters are configured."

  if ! docker network inspect "${VFM_DEV_KIND_NETWORK}" \
        --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null \
        | grep -qx "${name}"; then
    docker network connect --alias minio "${VFM_DEV_KIND_NETWORK}" "${name}" >/dev/null 2>&1 || die \
      "could not join ${name} to the '${VFM_DEV_KIND_NETWORK}' docker network" \
      "Retry manually: docker network connect ${VFM_DEV_KIND_NETWORK} ${name}"
  fi

  ip="$(docker container inspect "${name}" \
        --format "{{with index .NetworkSettings.Networks \"${VFM_DEV_KIND_NETWORK}\"}}{{.IPAddress}}{{end}}" \
        2>/dev/null)"
  [[ -n "${ip}" ]] || die \
    "${name} has no address on the '${VFM_DEV_KIND_NETWORK}' network" \
    "Inspect it with: docker container inspect ${name}"
  printf '%s' "${ip}"
}

# host_gateway_ip — the address of the `kind` docker bridge gateway, which is
# the host as seen from inside a kind node. Kept for diagnostics; MinIO is
# reached via minio_kind_ip instead (see above).
host_gateway_ip() {
  local ip
  ip="$(docker network inspect "${VFM_DEV_KIND_NETWORK}" \
        --format '{{range .IPAM.Config}}{{if .Gateway}}{{.Gateway}}{{"\n"}}{{end}}{{end}}' \
        2>/dev/null | grep -E '^[0-9]+\.' | head -1)"
  [[ -n "${ip}" ]] || die \
    "could not determine the IPv4 gateway of the '${VFM_DEV_KIND_NETWORK}' docker network" \
    "The network is created by kind; it should exist once a cluster has been created." \
    "Inspect it with: docker network inspect ${VFM_DEV_KIND_NETWORK}"
  printf '%s' "${ip}"
}
