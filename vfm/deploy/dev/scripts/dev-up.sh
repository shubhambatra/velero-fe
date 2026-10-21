#!/usr/bin/env bash
# Bring up the whole VFM local development environment (PLAN.md §14.1).
#
#   ./scripts/dev-up.sh              everything
#   ./scripts/dev-up.sh --compose-only
#   ./scripts/dev-up.sh --clusters-only
#   ./scripts/dev-up.sh --cluster vfm-a
#
# What it does:
#   1. preflight: tools, docker daemon, host ports
#   2. docker compose: PostgreSQL, Valkey, MinIO (+2 buckets), Mailpit, Dex
#   3. for each of vfm-a / vfm-b:
#        kind cluster (only if its context does not already exist)
#        CSI snapshot controller CRDs + controller
#        hostpath CSI driver + StorageClass + VolumeSnapshotClass
#        a Service pointing at the host MinIO
#        Velero VELERO_PRIMARY + AWS plugin against that cluster's bucket,
#          with the node agent on for filesystem backup
#        sample workloads in namespace `demo`
#
# Idempotent: re-running reports "already present" for each piece that is
# already there and never errors out because of it.
#
# Needs no `make`. Takes several minutes on a cold machine, most of it kind
# creating nodes and pulling images.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DO_COMPOSE=1
DO_CLUSTERS=1
TARGET_CLUSTERS=("${VFM_DEV_CLUSTERS[@]}")

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while (( $# )); do
  case "$1" in
    --compose-only)  DO_CLUSTERS=0; shift ;;
    --clusters-only) DO_COMPOSE=0; shift ;;
    --cluster)
      [[ -n "${2:-}" ]] || die "--cluster needs a name"
      assert_owned_cluster "$2"
      TARGET_CLUSTERS=("$2"); shift 2 ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage 1 ;;
  esac
done

load_env
ensure_generated_dir

VELERO_CREDENTIALS_FILE="${VFM_DEV_GENERATED_DIR}/velero-credentials-minio"
# Where in-cluster workloads reach the host MinIO. See
# manifests/host-gateway/minio.yaml.tmpl for how this name is wired up.
MINIO_IN_CLUSTER_URL="http://minio.vfm-dev.svc.cluster.local:9000"

# =============================================================================
# 1. Preflight
# =============================================================================
preflight() {
  step "Preflight"

  require_docker
  ok "docker $(docker version --format '{{.Server.Version}}') daemon reachable"

  if (( DO_CLUSTERS )); then
    require_tool kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
    require_tool kubectl "https://kubernetes.io/docs/tasks/tools/"
    require_tool velero "https://velero.io/docs/v1.18/basic-install/#install-the-cli"
    ok "kind $(kind version | head -1)"
    ok "kubectl $(kubectl version --client=true -o yaml 2>/dev/null | awk '/gitVersion/{print $2; exit}')"

    local cli_version
    cli_version="$(velero version --client-only 2>/dev/null | awk '/Version:/{print $2; exit}')"
    ok "velero CLI ${cli_version}"
    if [[ "${cli_version}" != "${VFM_VELERO_VERSION}" ]]; then
      # Not fatal, and deliberately so: the server version is pinned by
      # --image, so the CLI only has to be the same minor.
      warn "velero CLI is ${cli_version}, VELERO_PRIMARY is ${VFM_VELERO_VERSION};"
      warn "the server image is pinned explicitly to ${VFM_VELERO_IMAGE}, so this is fine"
      warn "as long as the minor matches."
    fi
  fi

  if (( DO_CLUSTERS )); then
    require_inotify_limits
  fi

  if (( DO_COMPOSE )); then
    require_host_port "${VFM_DEV_POSTGRES_PORT}"      "PostgreSQL"
    require_host_port "${VFM_DEV_VALKEY_PORT}"        "Valkey"
    require_host_port "${VFM_DEV_MINIO_API_PORT}"     "MinIO API"
    require_host_port "${VFM_DEV_MINIO_CONSOLE_PORT}" "MinIO console"
    require_host_port "${VFM_DEV_MAILPIT_SMTP_PORT}"  "Mailpit SMTP"
    require_host_port "${VFM_DEV_MAILPIT_UI_PORT}"    "Mailpit UI"
    require_host_port "${VFM_DEV_DEX_PORT}"           "Dex"
    ok "all host ports are free or already ours"
  fi

  # versions.env is documented as the source of truth for the pins, but compose
  # cannot interpolate image tags from a second env file, so the tags are
  # literal in docker-compose.yml. Catch the two drifting apart.
  local img
  for img in "${VFM_POSTGRES_IMAGE}" "${VFM_VALKEY_IMAGE}" "${VFM_MINIO_IMAGE}" \
             "${VFM_MINIO_CLIENT_IMAGE}" "${VFM_MAILPIT_IMAGE}" "${VFM_DEX_IMAGE}"; do
    grep -qF "image: ${img}" "${VFM_DEV_COMPOSE_FILE}" || die \
      "docker-compose.yml does not pin ${img}" \
      "versions.env and docker-compose.yml have drifted apart." \
      "Update the 'image:' line in docker-compose.yml to match versions.env."
  done
  ok "docker-compose.yml image pins match versions.env"
}

# =============================================================================
# 2. Compose stack
# =============================================================================
bring_up_compose() {
  step "Docker compose stack (project ${VFM_DEV_COMPOSE_PROJECT})"

  log "pulling images (pinned; see versions.env)"
  compose pull --quiet 2>&1 | sed 's/^/    /' || die \
    "failed to pull one or more compose images" \
    "Re-run with: $(printf '%q ' docker compose --env-file "${VFM_DEV_ENV_FILE}" -f "${VFM_DEV_COMPOSE_FILE}" pull)" \
    "to see which. Note that MinIO's own registries no longer serve anonymous" \
    "pulls — see README.md 'MinIO image provenance'."

  log "starting services and waiting for healthchecks"
  # `--wait` treats *any* exited container as a failure, so the one-shot
  # bucket provisioner cannot be part of this set — it exits 0 by design.
  # The long-running services are named explicitly and minio-init is started
  # and checked separately below.
  if ! compose up --detach --wait --wait-timeout 300 --remove-orphans \
        postgres valkey minio mailpit dex; then
    printf '\n%s--- logs (last 30 lines per service) ---%s\n' "${_c_dim}" "${_c_reset}" >&2
    compose logs --tail 30 >&2 || true
    # State last, so it is the final thing on screen after the log dump.
    printf '\n%s--- compose state ---%s\n' "${_c_dim}" "${_c_reset}" >&2
    compose ps --all --format 'table {{.Service}}\t{{.Status}}' >&2 || true
    die "the compose stack did not become healthy within 300s" \
        "The per-service state is immediately above; logs are above that."
  fi

  # minio-init is a one-shot that creates and then verifies both buckets. It is
  # re-run on every dev-up: creating a bucket that already exists is a no-op,
  # and re-running proves the buckets are still there.
  log "provisioning buckets"
  compose up --detach --force-recreate minio-init >/dev/null 2>&1 || true

  local init_cid init_exit
  init_cid="$(compose ps --all --quiet minio-init)"
  [[ -n "${init_cid}" ]] || die "the minio-init container was never created" \
    "Check: $(printf '%q ' docker compose -f "${VFM_DEV_COMPOSE_FILE}") config"
  # Give the one-shot a bounded window to finish before reading its exit code,
  # so a slow MinIO start is not misreported as a provisioning failure.
  local waited=0
  while [[ "$(docker inspect "${init_cid}" --format '{{.State.Running}}')" == "true" ]]; do
    (( waited >= 60 )) && die "minio-init did not finish within 60s" \
      "Inspect it with: docker logs ${init_cid}"
    sleep 2
    waited=$(( waited + 2 ))
  done

  init_exit="$(docker inspect "${init_cid}" --format '{{.State.ExitCode}}')"
  if [[ "${init_exit}" != "0" ]]; then
    docker logs "${init_cid}" >&2 || true
    die "bucket provisioning failed (minio-init exited ${init_exit})" \
        "Its log is above."
  fi
  ok "buckets present: ${VFM_DEV_BUCKET_A}, ${VFM_DEV_BUCKET_B}"

  compose ps --all --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/    /'
}

# Velero reads MinIO through the AWS plugin, so it needs an AWS-style
# credentials file. Written to .generated/ (gitignored), mode 0600.
write_velero_credentials() {
  umask 077
  cat >"${VELERO_CREDENTIALS_FILE}" <<EOF
# Generated by deploy/dev/scripts/dev-up.sh from deploy/dev/dev.env.
# Dev-only MinIO root credentials. Not committed (.generated/ is gitignored).
[default]
aws_access_key_id=${MINIO_ROOT_USER}
aws_secret_access_key=${MINIO_ROOT_PASSWORD}
EOF
  chmod 600 "${VELERO_CREDENTIALS_FILE}"
  ok "wrote ${VELERO_CREDENTIALS_FILE#"${VFM_DEV_DIR}/"} (mode 0600)"
}

# Prove MinIO is reachable from the `kind` network before asking Velero to use
# it, so a networking problem is reported here rather than as an opaque
# BackupStorageLocation failure twenty lines later.
verify_minio_reachable_from_kind_network() {
  local addr="$1" port="$2"
  log "checking http://${addr}:${port} from the '${VFM_DEV_KIND_NETWORK}' network"
  local out
  if ! out="$(docker run --rm --network "${VFM_DEV_KIND_NETWORK}" \
        "${VFM_SAMPLE_BUSYBOX_IMAGE}" \
        wget -q -T 10 -O - "http://${addr}:${port}/minio/health/live" 2>&1)"; then
    die "MinIO is not reachable from the '${VFM_DEV_KIND_NETWORK}' docker network" \
        "Tried: http://${addr}:${port}/minio/health/live" \
        "Output: ${out:-<empty>}" \
        "" \
        "MinIO is published on the host as 127.0.0.1:${VFM_DEV_MINIO_API_PORT} and joined to" \
        "the '${VFM_DEV_KIND_NETWORK}' network as a second attachment, which is the address" \
        "above. Check both with:" \
        "  docker container inspect ${VFM_DEV_COMPOSE_PROJECT}-minio" \
        "  docker network inspect ${VFM_DEV_KIND_NETWORK}"
  fi
  ok "MinIO reachable at ${addr}:${port} from the kind network"
}

# =============================================================================
# 3. Per-cluster setup
# =============================================================================

ensure_kind_cluster() {
  local cluster="$1" ctx; ctx="$(kube_ctx "${cluster}")"
  assert_owned_cluster "${cluster}"

  local config="${VFM_DEV_DIR}/kind/${cluster}.yaml"
  [[ "${VFM_DEV_SOLO:-0}" == 1 ]] && config="${VFM_DEV_DIR}/kind/${cluster}-solo.yaml"
  [[ -f "${config}" ]] || die "kind config not found: ${config}"

  # The idempotency guard the task calls for: create only when the context is
  # absent. Both checks are made because they can disagree — a cluster whose
  # kubeconfig entry was deleted by hand, say.
  if kube_context_exists "${ctx}" && kind_cluster_exists "${cluster}"; then
    skip "kind cluster ${cluster} (context ${ctx})"
    return 0
  fi
  if kind_cluster_exists "${cluster}" && ! kube_context_exists "${ctx}"; then
    log "cluster ${cluster} exists but context ${ctx} is missing — exporting kubeconfig"
    kind export kubeconfig --name "${cluster}"
    ok "context ${ctx} restored"
    return 0
  fi

  log "creating kind cluster ${cluster} (this takes a few minutes)"
  log "node image: ${VFM_KIND_NODE_IMAGE}"
  kind create cluster \
    --name "${cluster}" \
    --config "${config}" \
    --image "${VFM_KIND_NODE_IMAGE}" \
    --wait 180s \
    || die "kind failed to create cluster ${cluster}" \
           "Re-run: kind create cluster --name ${cluster} --config ${config} --image ${VFM_KIND_NODE_IMAGE}" \
           "If it timed out, the machine may simply be slow — see README.md troubleshooting."
  ok "cluster ${cluster} created"
}

wait_nodes_ready() {
  local ctx="$1"
  wait_condition "${ctx}" - "nodes --all" "condition=Ready" 180
  kc "${ctx}" get nodes \
    -o custom-columns='NODE:.metadata.name,STATUS:.status.conditions[-1].type,LABELS:.metadata.labels.vfm\.dev/csi-hostpath' \
    | sed 's/^/    /'
}

install_snapshot_controller() {
  local ctx="$1"
  local dir="${VFM_DEV_MANIFESTS_DIR}/snapshot-controller"

  if kc "${ctx}" get crd volumesnapshots.snapshot.storage.k8s.io >/dev/null 2>&1 \
     && kc "${ctx}" -n kube-system get deployment snapshot-controller >/dev/null 2>&1; then
    skip "CSI snapshot controller ${VFM_SNAPSHOTTER_VERSION}"
  else
    log "applying CSI snapshot CRDs + controller ${VFM_SNAPSHOTTER_VERSION} (vendored)"
    kc "${ctx}" apply -f "${dir}/crd-volumesnapshotclasses.yaml" \
                      -f "${dir}/crd-volumesnapshotcontents.yaml" \
                      -f "${dir}/crd-volumesnapshots.yaml" | sed 's/^/    /'
    # The CRDs must be established before the controller's informers start.
    wait_condition "${ctx}" - \
      "crd/volumesnapshots.snapshot.storage.k8s.io" "condition=Established" 120
    kc "${ctx}" apply -f "${dir}/rbac-snapshot-controller.yaml" \
                      -f "${dir}/setup-snapshot-controller.yaml" | sed 's/^/    /'
  fi
  wait_rollout "${ctx}" kube-system deployment/snapshot-controller 300
}

install_csi_hostpath() {
  local ctx="$1"
  local dir="${VFM_DEV_MANIFESTS_DIR}/csi-hostpath"

  if kc "${ctx}" get csidriver hostpath.csi.k8s.io >/dev/null 2>&1 \
     && kc "${ctx}" -n default get statefulset csi-hostpathplugin >/dev/null 2>&1; then
    skip "hostpath CSI driver ${VFM_CSI_HOSTPATH_VERSION}"
  else
    log "applying hostpath CSI driver ${VFM_CSI_HOSTPATH_VERSION} (vendored)"
    kc "${ctx}" apply \
      -f "${dir}/00-csidriver.yaml" \
      -f "${dir}/10-rbac.yaml" \
      -f "${dir}/20-plugin.yaml" \
      -f "${dir}/30-storageclass.yaml" \
      -f "${dir}/40-volumesnapshotclass.yaml" | sed 's/^/    /'
  fi
  wait_rollout "${ctx}" default statefulset/csi-hostpathplugin 420

  # Without a registered CSINode entry the provisioner has nowhere to place a
  # volume, and a PVC would hang in Pending with no obvious cause.
  wait_for 120 "the hostpath driver to register on a node" \
    bash -c "kubectl --context '${ctx}' get csinode -o jsonpath='{.items[*].spec.drivers[*].name}' | grep -q hostpath.csi.k8s.io"

  kc "${ctx}" get storageclass csi-hostpath-sc volumesnapshotclass csi-hostpath-snapclass \
    --ignore-not-found -o name | sed 's/^/    /'
}

install_minio_service() {
  local ctx="$1" cluster="$2" addr="$3" port="$4"
  local tmpl="${VFM_DEV_MANIFESTS_DIR}/host-gateway/minio.yaml.tmpl"
  local rendered="${VFM_DEV_GENERATED_DIR}/${cluster}-minio-endpoint.yaml"

  sed -e "s|__MINIO_HOST_IP__|${addr}|g" \
      -e "s|__MINIO_HOST_PORT__|${port}|g" \
      "${tmpl}" >"${rendered}"
  grep -q '__MINIO_HOST' "${rendered}" \
    && die "failed to render ${tmpl} (placeholders left over)"

  # Always applied, never skipped: MinIO's address on the docker network
  # changes whenever that network or the container is recreated, and apply is
  # what corrects it.
  log "pointing minio.vfm-dev.svc at ${addr}:${port}"
  kc "${ctx}" apply -f "${rendered}" | sed 's/^/    /'
  ok "in-cluster MinIO URL: ${MINIO_IN_CLUSTER_URL}"
}

install_velero() {
  local ctx="$1" cluster="$2"
  local bucket; bucket="$(bucket_for "${cluster}")"

  if kc "${ctx}" -n velero get deployment velero >/dev/null 2>&1; then
    local running_image
    running_image="$(kc "${ctx}" -n velero get deployment velero \
      -o jsonpath='{.spec.template.spec.containers[0].image}')"
    skip "Velero in ${cluster} (image ${running_image})"
    if [[ "${running_image}" != "${VFM_VELERO_IMAGE}" ]]; then
      warn "installed Velero image ${running_image} != pinned ${VFM_VELERO_IMAGE}"
      warn "run ./scripts/dev-down.sh --cluster ${cluster} and dev-up again to reinstall"
    fi
  else
    log "installing Velero ${VFM_VELERO_VERSION} into ${cluster} (bucket ${bucket})"
    log "  image:  ${VFM_VELERO_IMAGE}"
    log "  plugin: ${VFM_VELERO_AWS_PLUGIN_IMAGE}"
    log "  s3Url:  ${MINIO_IN_CLUSTER_URL}"
    # --image is mandatory, not cosmetic: the CLI defaults to its own version
    # (v1.18.2 locally), and VELERO_PRIMARY is v1.18.4 (DECISIONS.md ADR-002).
    # --use-volume-snapshots=false: no VolumeSnapshotLocation, because the AWS
    # plugin cannot take EBS snapshots against MinIO. CSI snapshots are a
    # separate path, built into the Velero server since v1.14, and are wired up
    # by the labelled VolumeSnapshotClass instead.
    # checksumAlgorithm="" keeps the AWS SDK from sending trailing checksums
    # that non-AWS S3 implementations reject.
    velero install \
      --kubecontext "${ctx}" \
      --provider aws \
      --image "${VFM_VELERO_IMAGE}" \
      --plugins "${VFM_VELERO_AWS_PLUGIN_IMAGE}" \
      --bucket "${bucket}" \
      --secret-file "${VELERO_CREDENTIALS_FILE}" \
      --backup-location-config "region=${VFM_DEV_MINIO_REGION},s3ForcePathStyle=true,s3Url=${MINIO_IN_CLUSTER_URL},checksumAlgorithm=" \
      --use-node-agent \
      --use-volume-snapshots=false \
      --wait \
      || die "velero install failed in ${cluster}" \
             "Check: kubectl --context ${ctx} -n velero get pods" \
             "       kubectl --context ${ctx} -n velero logs deployment/velero"
  fi

  wait_rollout "${ctx}" velero deployment/velero 300
  # node-agent is the filesystem-backup path (PLAN.md §14.1).
  wait_for 300 "the velero node-agent daemonset to be fully ready" \
    bash -c "
      desired=\$(kubectl --context '${ctx}' -n velero get daemonset node-agent -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null)
      ready=\$(kubectl --context '${ctx}' -n velero get daemonset node-agent -o jsonpath='{.status.numberReady}' 2>/dev/null)
      [[ -n \"\$desired\" && \"\$desired\" != '0' && \"\$desired\" == \"\$ready\" ]]"
  kc "${ctx}" -n velero get deployment/velero daemonset/node-agent \
    -o custom-columns='KIND:.kind,NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image' \
    | sed 's/^/    /'

  # The authoritative proof that Velero can actually reach MinIO: the server
  # validates the location and sets the phase itself.
  wait_for 180 "BackupStorageLocation 'default' to become Available" \
    bash -c "[[ \"\$(kubectl --context '${ctx}' -n velero get backupstoragelocation default -o jsonpath='{.status.phase}' 2>/dev/null)\" == 'Available' ]]"
  kc "${ctx}" -n velero get backupstoragelocation default \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,BUCKET:.spec.objectStorage.bucket,URL:.spec.config.s3Url' \
    | sed 's/^/    /'
}

setup_cluster() {
  local cluster="$1" addr="$2" port="$3"
  local ctx; ctx="$(kube_ctx "${cluster}")"

  step "Cluster ${cluster} (context ${ctx})"
  ensure_kind_cluster "${cluster}"
  wait_nodes_ready "${ctx}"
  install_snapshot_controller "${ctx}"
  install_csi_hostpath "${ctx}"
  install_minio_service "${ctx}" "${cluster}" "${addr}" "${port}"
  install_velero "${ctx}" "${cluster}"
  "${VFM_DEV_SCRIPTS_DIR}/sample-workloads.sh" --cluster "${cluster}"
}

# =============================================================================
# main
# =============================================================================
main() {
  local started=${SECONDS}

  printf '%sVFM dev environment%s  —  Velero %s, Kubernetes %s\n' \
    "${_c_bold}" "${_c_reset}" "${VFM_VELERO_VERSION}" "${VFM_KIND_K8S_VERSION}"

  preflight

  if (( DO_COMPOSE )); then
    bring_up_compose
  else
    log "skipping the compose stack (--clusters-only)"
  fi

  if (( DO_CLUSTERS )); then
    step "Velero MinIO credentials"
    write_velero_credentials

    # The `kind` network is created by kind itself, so the first cluster has to
    # exist before its gateway can be read.
    local first="${TARGET_CLUSTERS[0]}"
    step "Bootstrapping cluster ${first} to establish the '${VFM_DEV_KIND_NETWORK}' network"
    ensure_kind_cluster "${first}"

    # MinIO joins the `kind` network as a second attachment, so the clusters
    # reach it directly and the host publishing can stay loopback-only.
    local minio_addr; minio_addr="$(minio_kind_ip)"
    local minio_port=9000
    ok "MinIO on the '${VFM_DEV_KIND_NETWORK}' network: ${minio_addr}:${minio_port}"
    verify_minio_reachable_from_kind_network "${minio_addr}" "${minio_port}"

    local cluster
    for cluster in "${TARGET_CLUSTERS[@]}"; do
      setup_cluster "${cluster}" "${minio_addr}" "${minio_port}"
    done
  else
    log "skipping the kind clusters (--compose-only)"
  fi

  step "Ready"
  cat <<EOF
    compose project : ${VFM_DEV_COMPOSE_PROJECT}
    PostgreSQL      : postgresql://${POSTGRES_USER}:***@127.0.0.1:${VFM_DEV_POSTGRES_PORT}/${POSTGRES_DB}
    Valkey          : redis://127.0.0.1:${VFM_DEV_VALKEY_PORT}
    MinIO API       : http://127.0.0.1:${VFM_DEV_MINIO_API_PORT}   (user ${MINIO_ROOT_USER})
    MinIO console   : http://127.0.0.1:${VFM_DEV_MINIO_CONSOLE_PORT}
    Mailpit UI      : http://127.0.0.1:${VFM_DEV_MAILPIT_UI_PORT}   (SMTP 127.0.0.1:${VFM_DEV_MAILPIT_SMTP_PORT})
    Dex issuer      : ${VFM_DEV_OIDC_ISSUER}
EOF
  if (( DO_CLUSTERS )); then
    local cluster
    for cluster in "${TARGET_CLUSTERS[@]}"; do
      printf '    %-15s : context %s, bucket %s\n' \
        "${cluster}" "$(kube_ctx "${cluster}")" "$(bucket_for "${cluster}")"
    done
    printf '\n    Next: ./scripts/smoke.sh   (asserts a Velero backup Completes on each cluster)\n'
  fi
  printf '\n    took %dm%02ds\n\n' $(( (SECONDS - started) / 60 )) $(( (SECONDS - started) % 60 ))
}

main "$@"
