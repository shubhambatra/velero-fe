#!/usr/bin/env bash
#
# startup.sh — production-ready bootstrap script for Velero UI (otwld/velero-ui)
#
# Fully bootstraps this project on a fresh machine: verifies/installs prerequisites,
# clones the repo if needed, installs dependencies, configures the environment,
# builds/starts the app in Development or Production mode, validates health, and
# prints a summary of URLs, credentials, and management commands.
#
# Notes on scope (verified against the actual upstream repo):
#   - Go is NOT used anywhere in this codebase (Node.js/TypeScript only) — no Go
#     prerequisite is checked; this is intentional, not an oversight.
#   - No docker-compose.yml exists upstream (Compose support is officially
#     "Coming Soon" per the project docs) — this script follows the real,
#     documented Docker / Kubernetes / Helm flows instead of inventing one.
#   - This project has no traditional database. Its live data source is the
#     Kubernetes API (Velero CRDs). "Database validation" is therefore performed
#     via the app's real GET /health endpoint, which checks Kubernetes API
#     reachability and the Velero server pod status.
#
# Usage:
#   ./startup.sh                          Interactive menu
#   ./startup.sh --dev [--yes]            Start development servers
#   ./startup.sh --prod [--prod-target=node|docker] [--yes]
#   ./startup.sh --status                 Show live status + re-run health checks
#   ./startup.sh --stop                   Stop everything this script started
#   ./startup.sh --restart [--dev|--prod] Stop then restart (last mode, or given)
#   ./startup.sh --help                   Full usage
#
set -Eeuo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Globals / constants
# ---------------------------------------------------------------------------
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_ROOT="$(dirname "$SCRIPT_PATH")"
REPO_URL="https://github.com/otwld/velero-ui.git"

MIN_NODE_MAJOR=22
BACKEND_PORT="${BACKEND_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-4200}"
DOCKER_IMAGE="otwld/velero-ui"
DOCKER_CONTAINER_NAME="velero-ui"
DOCKER_HOST_PORT=3333
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=2

STATE_DIR="$REPO_ROOT/.startup"
PID_DIR="$STATE_DIR/pids"
PORTS_FILE="$STATE_DIR/ports"
LOG_DIR="$REPO_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RUN_LOG="$LOG_DIR/startup-${TIMESTAMP}.log"

MODE=""                 # dev | prod
ACTION="run"             # run | stop | restart | status | help
PROD_TARGET=""            # node | docker
ASSUME_YES=0
SKIP_DEPS=0
DO_K8S_DEPLOY=0
DO_HELM_DEPLOY=0
BACKEND_PORT_EXPLICIT=0
FRONTEND_PORT_EXPLICIT=0
NO_COLOR_FLAG=0
LOCK_FD=200
LOCK_ACQUIRED=0

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
is_tty() { [[ -t 1 ]]; }

use_color() {
  [[ "$NO_COLOR_FLAG" -eq 0 ]] && is_tty && [[ -z "${NO_COLOR:-}" ]]
}

if use_color 2>/dev/null; then :; fi # placeholder, real check happens per-call below

_c() {
  # _c <color-code> <text>
  if use_color; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi
}

log_info()    { printf '%s %s\n' "$(_c '36' '[INFO]')"    "$*"; }
log_warn()    { printf '%s %s\n' "$(_c '33' '[WARN]')"    "$*"; }
log_error()   { printf '%s %s\n' "$(_c '31' '[ERROR]')"   "$*" >&2; }
log_success() { printf '%s %s\n' "$(_c '32' '[SUCCESS]')" "$*"; }
log_step()    { printf '\n%s %s\n' "$(_c '35' '==>')"      "$*"; }

log_init() {
  mkdir -p "$LOG_DIR"
  # Tee all stdout/stderr for this invocation into a timestamped log file.
  exec > >(tee -a "$RUN_LOG") 2> >(tee -a "$RUN_LOG" >&2)
  log_info "Logging this run to: $RUN_LOG"
}

# ---------------------------------------------------------------------------
# Traps
# ---------------------------------------------------------------------------
on_error() {
  local exit_code=$?
  local line_no=${1:-$LINENO}
  log_error "Command failed (exit ${exit_code}) at line ${line_no}: ${BASH_COMMAND}"
  log_error "See the full run log for details: ${RUN_LOG}"
  exit "$exit_code"
}

on_exit() {
  local exit_code=$?
  if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    flock -u "$LOCK_FD" 2>/dev/null || true
  fi
  if [[ -f "$RUN_LOG" ]]; then
    log_info "Full log saved to: $RUN_LOG"
  fi
  exit "$exit_code"
}

on_interrupt() {
  log_warn "Interrupted — stopping anything this invocation started..."
  do_stop || true
  exit 130
}

trap 'on_error $LINENO' ERR
trap on_exit EXIT
trap on_interrupt INT TERM

# ---------------------------------------------------------------------------
# Lock (prevents concurrent runs)
# ---------------------------------------------------------------------------
acquire_lock() {
  mkdir -p "$STATE_DIR"
  exec 200>"$STATE_DIR/startup.lock"
  if ! flock -n "$LOCK_FD"; then
    log_error "Another instance of startup.sh appears to be running (lock: $STATE_DIR/startup.lock)."
    log_error "If you're sure that's not the case, remove the lock file and retry."
    exit 1
  fi
  LOCK_ACQUIRED=1
}

# ---------------------------------------------------------------------------
# Prompt helper (respects --yes / non-interactive)
# ---------------------------------------------------------------------------
confirm() {
  # confirm "question" [default: Y|N]
  local question="$1" default="${2:-N}"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  if ! is_tty; then
    log_warn "Non-interactive session and no --yes given — defaulting to '${default}' for: ${question}"
    [[ "$default" == "Y" ]] && return 0 || return 1
  fi
  local prompt="[y/N]"
  [[ "$default" == "Y" ]] && prompt="[Y/n]"
  read -r -p "$question $prompt " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# Usage / flag parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
startup.sh — bootstrap Velero UI (otwld/velero-ui) for Development or Production

Usage:
  ./startup.sh [options]

Modes:
  --dev                     Start development servers (backend + frontend, hot reload)
  --prod                    Build and run in production mode
  --prod-target=node|docker Disambiguate prod execution path (skips the interactive prompt)

Actions:
  --status                  Show live status of managed processes + re-run health checks
  --stop                    Stop everything this script started (dev servers / prod process / container)
  --restart                 Stop then restart (uses last known mode unless --dev/--prod given)

Behavior flags:
  --yes, -y, --non-interactive   Auto-confirm all prompts (installs, overwrites-with-backup, rebuilds, pulls)
  --skip-deps, --no-install-missing   Only check prerequisites, never auto-install
  --k8s-deploy               Also apply the raw Kubernetes manifests (kubernetes/manifests) + port-forward
  --helm-deploy              Also install/upgrade the Helm chart into the cluster (prints an RBAC warning)
  --port=<n>                 Override backend port (default 3000)
  --frontend-port=<n>        Override frontend dev port (default 4200)
  --no-color                 Disable colored output
  --help, -h                 Show this help and exit

With no flags at all, an interactive menu is shown.

Examples:
  ./startup.sh --dev --yes
  ./startup.sh --prod --prod-target=docker --yes
  ./startup.sh --status
  ./startup.sh --stop
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dev) MODE="dev" ;;
      --prod) MODE="prod" ;;
      --prod-target=*) PROD_TARGET="${1#*=}" ;;
      --prod-target) PROD_TARGET="${2:-}"; shift ;;
      --yes|-y|--non-interactive) ASSUME_YES=1 ;;
      --skip-deps|--no-install-missing) SKIP_DEPS=1 ;;
      --k8s-deploy) DO_K8S_DEPLOY=1 ;;
      --helm-deploy) DO_HELM_DEPLOY=1 ;;
      --stop) ACTION="stop" ;;
      --restart) ACTION="restart" ;;
      --status) ACTION="status" ;;
      --port=*) BACKEND_PORT="${1#*=}"; BACKEND_PORT_EXPLICIT=1 ;;
      --port) BACKEND_PORT="${2:-}"; BACKEND_PORT_EXPLICIT=1; shift ;;
      --frontend-port=*) FRONTEND_PORT="${1#*=}"; FRONTEND_PORT_EXPLICIT=1 ;;
      --frontend-port) FRONTEND_PORT="${2:-}"; FRONTEND_PORT_EXPLICIT=1; shift ;;
      --no-color) NO_COLOR_FLAG=1 ;;
      --help|-h) ACTION="help" ;;
      *)
        log_error "Unknown option: $1"
        usage
        exit 2
        ;;
    esac
    shift
  done

  if [[ "$PROD_TARGET" != "" && "$PROD_TARGET" != "node" && "$PROD_TARGET" != "docker" ]]; then
    log_error "--prod-target must be 'node' or 'docker', got: $PROD_TARGET"
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# OS / package manager detection
# ---------------------------------------------------------------------------
OS_FAMILY=""
DISTRO=""
PKG_MANAGER=""
IS_WSL=0

detect_os() {
  case "$(uname -s)" in
    Linux)
      OS_FAMILY="linux"
      if grep -qi microsoft /proc/version 2>/dev/null; then
        IS_WSL=1
        log_info "Detected WSL (Windows Subsystem for Linux)."
      fi
      if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        DISTRO="$(. /etc/os-release && echo "${ID:-unknown}")"
      fi
      if command -v apt-get >/dev/null 2>&1; then PKG_MANAGER="apt"
      elif command -v dnf >/dev/null 2>&1; then PKG_MANAGER="dnf"
      elif command -v yum >/dev/null 2>&1; then PKG_MANAGER="yum"
      elif command -v pacman >/dev/null 2>&1; then PKG_MANAGER="pacman"
      else PKG_MANAGER="unknown"
      fi
      ;;
    Darwin)
      OS_FAMILY="darwin"
      DISTRO="macos"
      if command -v brew >/dev/null 2>&1; then PKG_MANAGER="brew"; else PKG_MANAGER="unknown"; fi
      ;;
    *)
      OS_FAMILY="unknown"
      PKG_MANAGER="unknown"
      ;;
  esac
  log_info "Detected OS: ${OS_FAMILY} (distro: ${DISTRO:-n/a}, package manager: ${PKG_MANAGER})"
  if [[ "$IS_WSL" -eq 1 && "$PKG_MANAGER" != "unknown" ]]; then
    log_info "Note: on WSL, Docker usually works best via Docker Desktop's WSL2 integration rather than dockerd installed inside WSL directly."
  fi
}

note_go_not_applicable() {
  log_info "Go toolchain check skipped — Go is not used anywhere in the velero-ui codebase (Node.js/TypeScript only)."
}

# ---------------------------------------------------------------------------
# Install command matrix
# ---------------------------------------------------------------------------
install_cmd_for() {
  # install_cmd_for <tool>  -> echoes the install command for current PKG_MANAGER
  local tool="$1"
  case "$tool:$PKG_MANAGER" in
    git:apt) echo "sudo apt-get update && sudo apt-get install -y git" ;;
    git:dnf) echo "sudo dnf install -y git" ;;
    git:yum) echo "sudo yum install -y git" ;;
    git:pacman) echo "sudo pacman -Sy --noconfirm git" ;;
    git:brew) echo "brew install git" ;;

    node:apt) echo "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
    node:dnf) echo "sudo dnf module install -y nodejs:22 || (curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs)" ;;
    node:yum) echo "curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs" ;;
    node:pacman) echo "sudo pacman -Sy --noconfirm nodejs npm" ;;
    node:brew) echo "brew install node@22 && brew link --overwrite node@22" ;;

    npm:apt) echo "sudo apt-get install -y npm" ;;
    npm:dnf) echo "sudo dnf install -y npm" ;;
    npm:yum) echo "sudo yum install -y npm" ;;
    npm:pacman) echo "sudo pacman -Sy --noconfirm npm" ;;
    npm:brew) echo "brew install node" ;;

    docker:apt) echo "curl -fsSL https://get.docker.com | sudo sh" ;;
    docker:dnf) echo "curl -fsSL https://get.docker.com | sudo sh" ;;
    docker:yum) echo "curl -fsSL https://get.docker.com | sudo sh" ;;
    docker:pacman) echo "sudo pacman -Sy --noconfirm docker && sudo systemctl enable --now docker" ;;
    docker:brew) echo "(manual) Download Docker Desktop for Mac: https://www.docker.com/products/docker-desktop/" ;;

    kubectl:apt|kubectl:dnf|kubectl:yum) echo 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && rm -f kubectl' ;;
    kubectl:pacman) echo "sudo pacman -Sy --noconfirm kubectl" ;;
    kubectl:brew) echo "brew install kubectl" ;;

    helm:apt|helm:dnf|helm:yum) echo "curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash" ;;
    helm:pacman) echo "sudo pacman -Sy --noconfirm helm" ;;
    helm:brew) echo "brew install helm" ;;

    *) echo "" ;;
  esac
}

prompt_install_or_skip() {
  # prompt_install_or_skip <tool> <plain_explanation> [required_for]
  local tool="$1" explanation="$2" required_for="${3:-this mode}"
  local cmd
  cmd="$(install_cmd_for "$tool")"

  log_warn "${tool} is missing or too old. ${explanation}"
  if [[ -z "$cmd" ]]; then
    log_error "No known install command for '${tool}' on this system (package manager: ${PKG_MANAGER})."
    log_error "Please install ${tool} manually, then re-run this script."
    return 1
  fi

  log_info "Install command: ${cmd}"

  if [[ "$SKIP_DEPS" -eq 1 ]]; then
    log_warn "Skipping auto-install (--skip-deps given). ${required_for} will fail without ${tool}."
    return 1
  fi

  if confirm "Install ${tool} now?" "Y"; then
    log_step "Installing ${tool}..."
    if [[ "$cmd" == "(manual)"* ]]; then
      log_error "${cmd#(manual) }"
      return 1
    fi
    if bash -c "$cmd"; then
      log_success "${tool} installed."
      return 0
    else
      log_error "Automatic install of ${tool} failed. Please install it manually and re-run."
      return 1
    fi
  else
    log_warn "Skipping ${tool} install. ${required_for} will not work correctly without it."
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
check_git() {
  if command -v git >/dev/null 2>&1; then
    log_success "git found: $(git --version)"
    return 0
  fi
  prompt_install_or_skip "git" \
    "Git is the tool used to download (clone) and update the project's source code." \
    "Cloning/updating the repository"
}

check_node() {
  if command -v node >/dev/null 2>&1; then
    local ver major
    ver="$(node -v | sed 's/^v//')"
    major="${ver%%.*}"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR )); then
      log_success "Node.js found: v${ver} (>= ${MIN_NODE_MAJOR} required)"
      return 0
    fi
    log_warn "Node.js v${ver} found, but this project requires Node.js >= ${MIN_NODE_MAJOR}."
  fi
  prompt_install_or_skip "node" \
    "Node.js is the JavaScript runtime that powers both the backend API and the build tooling for this project. Version 22 or newer is required." \
    "Installing dependencies and running the app"
}

check_npm() {
  if command -v npm >/dev/null 2>&1; then
    log_success "npm found: $(npm -v)"
    return 0
  fi
  prompt_install_or_skip "npm" \
    "npm is the package manager used to download this project's dependencies." \
    "Installing dependencies"
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    prompt_install_or_skip "docker" \
      "Docker lets you build and run this app as a self-contained container image, matching the official production deployment method." \
      "Building/running the production Docker image"
    return $?
  fi
  if docker info >/dev/null 2>&1; then
    log_success "Docker found and daemon is running: $(docker --version)"
    return 0
  fi
  log_warn "Docker is installed, but the Docker daemon isn't reachable."
  log_warn "This usually means: the Docker service isn't running (try: sudo systemctl start docker),"
  log_warn "or your user lacks permission (try: sudo usermod -aG docker \$USER, then log out/in)."
  return 1
}

check_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then
    log_success "kubectl found: $(kubectl version --client --short 2>/dev/null || kubectl version --client 2>/dev/null | head -1)"
    return 0
  fi
  prompt_install_or_skip "kubectl" \
    "kubectl is the command-line tool used to talk to a Kubernetes cluster — needed to deploy this app to Kubernetes or check on the Velero installation it manages." \
    "Kubernetes/Helm deployment steps"
}

check_helm() {
  if command -v helm >/dev/null 2>&1; then
    log_success "Helm found: $(helm version --short 2>/dev/null)"
    return 0
  fi
  prompt_install_or_skip "helm" \
    "Helm is a package manager for Kubernetes, used for the official one-command chart installation of this app." \
    "Helm deployment step"
}

check_kube_access() {
  if ! command -v kubectl >/dev/null 2>&1; then
    log_warn "kubectl not available — skipping Kubernetes cluster connectivity check."
    return 1
  fi
  if kubectl cluster-info --request-timeout=5s >/dev/null 2>&1; then
    local ctx
    ctx="$(kubectl config current-context 2>/dev/null || echo 'unknown')"
    log_success "Kubernetes cluster reachable (context: ${ctx})."
    return 0
  fi
  log_warn "No reachable Kubernetes cluster found via the current kubeconfig."
  log_warn "This app is a dashboard for an existing Velero installation — it needs a working kubeconfig"
  log_warn "(default ~/.kube/config, or set KUBE_CONFIG_PATH/KUBE_CONTEXT in .env) with Velero server >= 1.13.0 already installed."
  log_warn "The app can still start without this, but its health check will report the Kubernetes/Velero indicators as failing."
  return 1
}

kube_server_is_loopback() {
  # Local clusters (kind, minikube, k3d, ...) commonly expose their API server
  # on 127.0.0.1/localhost. That address means "the container itself" inside a
  # normal Docker bridge network, not the host — a containerized velero-ui
  # would get ECONNREFUSED trying to reach it. Detect this so run_prod_docker
  # can compensate (see its --network host fallback).
  command -v kubectl >/dev/null 2>&1 || return 1
  local server
  server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
  [[ "$server" == *"127.0.0.1"* || "$server" == *"localhost"* ]]
}

# ---------------------------------------------------------------------------
# Repo context (clone-or-update, idempotent)
# ---------------------------------------------------------------------------
detect_repo_context() {
  if [[ -d "$REPO_ROOT/.git" ]]; then
    local remote
    remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"
    if [[ "$remote" == *"otwld/velero-ui"* ]]; then
      return 0
    fi
  fi
  if [[ -f "$REPO_ROOT/package.json" ]] && grep -q '"name": *"@otwld/velero-ui"' "$REPO_ROOT/package.json" 2>/dev/null; then
    return 0
  fi
  return 1
}

ensure_repo() {
  if detect_repo_context; then
    log_success "Already inside a velero-ui clone: $REPO_ROOT"
    if [[ -d "$REPO_ROOT/.git" ]] && confirm "Pull latest changes from origin?" "N"; then
      log_step "Pulling latest changes..."
      git -C "$REPO_ROOT" pull --ff-only
    fi
    return 0
  fi

  log_step "This directory is not a velero-ui clone — cloning ${REPO_URL}..."
  local target="$REPO_ROOT/velero-ui"
  git clone "$REPO_URL" "$target"
  log_success "Cloned into ${target}. Re-run this script from inside that directory."
  log_info "cd \"$target\" && ./startup.sh"
  exit 0
}

# ---------------------------------------------------------------------------
# Dependency install (idempotent)
# ---------------------------------------------------------------------------
deps_hash_current() {
  sha256sum "$REPO_ROOT/package-lock.json" 2>/dev/null | awk '{print $1}'
}

install_deps() {
  mkdir -p "$STATE_DIR"
  local hash_file="$STATE_DIR/node_modules.lock.sha256"
  local current_hash cached_hash

  current_hash="$(deps_hash_current)"
  cached_hash="$(cat "$hash_file" 2>/dev/null || echo "")"

  if [[ -d "$REPO_ROOT/node_modules" ]] && [[ -n "$(ls -A "$REPO_ROOT/node_modules" 2>/dev/null)" ]] \
     && [[ -n "$current_hash" ]] && [[ "$current_hash" == "$cached_hash" ]]; then
    log_success "Dependencies already up to date (node_modules present, package-lock.json unchanged) — skipping install."
    return 0
  fi

  log_step "Installing dependencies (npm ci)..."
  cd "$REPO_ROOT"
  if npm ci 2>&1 | tee -a "$RUN_LOG"; then
    echo "$current_hash" > "$hash_file"
    log_success "Dependencies installed via npm ci."
    return 0
  fi

  log_warn "npm ci failed — falling back to npm install..."
  if npm install 2>&1 | tee -a "$RUN_LOG"; then
    echo "$current_hash" > "$hash_file"
    log_success "Dependencies installed via npm install."
    return 0
  fi

  log_error "Dependency installation failed. Check the log above/at ${RUN_LOG} for the underlying npm error."
  return 1
}

# ---------------------------------------------------------------------------
# Env file setup
# ---------------------------------------------------------------------------
setup_env_file() {
  local env_file="$REPO_ROOT/.env"
  local example_file="$REPO_ROOT/.env.example"
  local hash_file="$STATE_DIR/env.sha256"

  if [[ ! -f "$example_file" ]]; then
    log_error ".env.example not found at ${example_file} — cannot generate environment configuration."
    return 1
  fi

  mkdir -p "$STATE_DIR"

  if [[ ! -f "$env_file" ]]; then
    cp "$example_file" "$env_file"
    sha256sum "$example_file" | awk '{print $1}' > "$hash_file"
    log_success "Created .env from .env.example."
  else
    log_success ".env already exists — leaving it untouched."
    local current_example_hash cached_example_hash
    current_example_hash="$(sha256sum "$example_file" | awk '{print $1}')"
    cached_example_hash="$(cat "$hash_file" 2>/dev/null || echo "")"
    if [[ -n "$cached_example_hash" && "$current_example_hash" != "$cached_example_hash" ]]; then
      log_warn ".env.example has changed upstream since your .env was generated."
      log_warn "Review differences with: diff .env .env.example"
      if confirm "Back up current .env and regenerate from the new .env.example?" "N"; then
        cp "$env_file" "${env_file}.bak.${TIMESTAMP}"
        cp "$example_file" "$env_file"
        echo "$current_example_hash" > "$hash_file"
        log_success "Backed up old .env to .env.bak.${TIMESTAMP} and regenerated from .env.example."
      fi
    fi
  fi

  # Doc-parity symlink used by the project's manual dev instructions; .env remains the
  # single real source of truth (NestJS's ConfigModule loads .env from CWD by default).
  if [[ ! -e "$REPO_ROOT/.env.development" ]]; then
    ln -s .env "$REPO_ROOT/.env.development"
    log_info "Created .env.development -> .env symlink (doc-parity; .env is the file actually read at runtime)."
  fi

  ensure_gitignore_entries
  print_security_reminder
}

ensure_gitignore_entries() {
  local gi="$REPO_ROOT/.gitignore"
  touch "$gi"
  for entry in ".startup/" "logs/" ".env.bak.*"; do
    grep -qxF "$entry" "$gi" 2>/dev/null || echo "$entry" >> "$gi"
  done
}

print_security_reminder() {
  local env_file="$REPO_ROOT/.env"
  [[ -f "$env_file" ]] || return 0
  local warned=0
  if grep -q '^AUTH_SECRET_PASSPHRASE="this is not a secret passphrase"' "$env_file" 2>/dev/null; then
    log_warn "SECURITY: AUTH_SECRET_PASSPHRASE in .env is still the insecure default. Change it before exposing this instance."
    warned=1
  fi
  if grep -q '^BASIC_AUTH_PASSWORD=admin' "$env_file" 2>/dev/null; then
    log_warn "SECURITY: BASIC_AUTH_PASSWORD in .env is still the default 'admin'. Change it before exposing this instance."
    warned=1
  fi
  [[ "$warned" -eq 0 ]] || log_warn "See .env for all authentication-related settings."
}

configure_local_kubeconfig() {
  # apps/velero-ui-api/src/app/app.module.ts: if KUBE_CONFIG_PATH is empty, the
  # app assumes it's running INSIDE a Kubernetes pod (LoadFrom.CLUSTER) and
  # builds its API server URL from KUBERNETES_SERVICE_HOST/PORT. Those only
  # exist inside a real pod. Running locally (nx serve, or `node` directly)
  # with KUBE_CONFIG_PATH left blank — the .env.example default — makes the
  # Kubernetes client build an empty/malformed URL and crash with
  # "TypeError: Invalid URL" shortly after startup. Auto-fill it from the
  # same kubeconfig `kubectl` already uses, but only if the user hasn't set
  # it themselves (never override an explicit choice).
  local env_file="$REPO_ROOT/.env"
  [[ -f "$env_file" ]] || return 0

  local current_path
  current_path="$(grep -E '^KUBE_CONFIG_PATH=' "$env_file" 2>/dev/null | cut -d= -f2-)"
  if [[ -n "$current_path" ]]; then
    return 0
  fi

  local candidate="${KUBECONFIG:-$HOME/.kube/config}"
  if [[ ! -f "$candidate" ]]; then
    log_warn "KUBE_CONFIG_PATH is empty in .env and no kubeconfig found at ${candidate}."
    log_warn "Running outside a real Kubernetes pod with this blank makes the app assume in-cluster"
    log_warn "config and fail. Set KUBE_CONFIG_PATH in .env to your kubeconfig file to fix this."
    return 1
  fi

  log_step "KUBE_CONFIG_PATH is empty in .env — filling it in with your local kubeconfig (${candidate})."
  log_info "This is only needed for local runs; a real in-cluster (Helm/K8s manifests) deployment"
  log_info "correctly leaves this blank and uses its service account instead."
  sed -i "s#^KUBE_CONFIG_PATH=.*#KUBE_CONFIG_PATH=${candidate}#" "$env_file"

  if command -v kubectl >/dev/null 2>&1; then
    local ctx current_ctx
    ctx="$(kubectl config current-context 2>/dev/null || true)"
    current_ctx="$(grep -E '^KUBE_CONTEXT=' "$env_file" 2>/dev/null | cut -d= -f2-)"
    if [[ -n "$ctx" && -z "$current_ctx" ]]; then
      sed -i "s#^KUBE_CONTEXT=.*#KUBE_CONTEXT=${ctx}#" "$env_file"
      log_info "Also set KUBE_CONTEXT=${ctx} (from 'kubectl config current-context')."
    fi
  fi

  log_success "Updated .env with a working KUBE_CONFIG_PATH."
}

load_env_into_shell() {
  # The frontend's vite.config.ts reads server.port: parseInt(process.env.VITE_PORT)
  # directly at config-eval time — Vite itself does NOT dotenv-load this file's own
  # config for us. Without exporting .env into the real shell environment first, the
  # dev server would crash trying to bind to NaN. Exporting here fixes that for both
  # VITE_PORT and VITE_API_URL (and is harmless/idempotent for the backend, which
  # loads .env itself via @nestjs/config regardless).
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
  export VITE_PORT="${VITE_PORT:-$FRONTEND_PORT}"
  export PORT="${PORT:-$BACKEND_PORT}"
}

# ---------------------------------------------------------------------------
# Port persistence
#
# --port/--frontend-port may be given once (e.g. on a --dev run) and then
# omitted on later --status/--stop/--restart invocations. Without remembering
# what was actually used, those later invocations would silently fall back to
# the hardcoded defaults (3000/4200) and report the wrong port. Persist the
# ports actually used to disk, and only let a persisted value fill in when the
# current invocation did not explicitly pass --port/--frontend-port itself.
# ---------------------------------------------------------------------------
persist_ports() {
  mkdir -p "$STATE_DIR"
  cat > "$PORTS_FILE" <<EOF
BACKEND_PORT=$BACKEND_PORT
FRONTEND_PORT=$FRONTEND_PORT
EOF
}

load_persisted_ports() {
  [[ -f "$PORTS_FILE" ]] || return 0
  local saved_backend saved_frontend
  saved_backend="$(grep -E '^BACKEND_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2-)"
  saved_frontend="$(grep -E '^FRONTEND_PORT=' "$PORTS_FILE" 2>/dev/null | cut -d= -f2-)"
  if [[ "$BACKEND_PORT_EXPLICIT" -eq 0 && -n "$saved_backend" ]]; then
    BACKEND_PORT="$saved_backend"
  fi
  if [[ "$FRONTEND_PORT_EXPLICIT" -eq 0 && -n "$saved_frontend" ]]; then
    FRONTEND_PORT="$saved_frontend"
  fi
}

# ---------------------------------------------------------------------------
# Port / process helpers
# ---------------------------------------------------------------------------
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"
  else
    return 1
  fi
}

pid_file_running() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

port_owner_info() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":${port} "
  fi
}

ensure_port_free() {
  # Guards against a confusing failure mode: if some unrelated process is
  # already bound to the port we need (e.g. a leftover dev server from a
  # different checkout of this project), the backend/frontend we're about to
  # start will fail to bind and the *other* process keeps answering requests
  # instead — producing misleading errors (like a 404 on a route that does
  # exist) far away from the real cause. Catch it here, before spawning
  # anything, with a clear message pointing at exactly what's occupying it.
  local port="$1" label="$2" our_pidfile="$3"
  if pid_file_running "$our_pidfile"; then
    return 0 # already tracked as our own process; caller handles reuse/restart
  fi
  if port_in_use "$port"; then
    log_error "Port ${port} (needed for the ${label}) is already in use by a process this script isn't managing:"
    port_owner_info "$port" | while IFS= read -r line; do log_error "  ${line}"; done
    log_error "Stop whatever is using port ${port}, or run with a different port, e.g.:"
    if [[ "$label" == *"frontend"* ]]; then
      log_error "  ./startup.sh --dev --frontend-port=<n>"
    else
      log_error "  ./startup.sh --dev --port=<n>   (or --prod --port=<n> for production)"
    fi
    return 1
  fi
  return 0
}

collect_descendants() {
  # Commands like `npx nx serve ...` keep a supervisor process alive with the
  # actual long-running Node/Nx process as a CHILD — sending SIGTERM to only
  # the recorded (parent) PID leaves that child running as an orphan. Walk the
  # process tree so stop_pid can signal every descendant, not just the parent.
  local parent="$1"
  command -v pgrep >/dev/null 2>&1 || return 0
  local children
  children="$(pgrep -P "$parent" 2>/dev/null || true)"
  local c
  for c in $children; do
    collect_descendants "$c"
    echo "$c"
  done
}

stop_pid() {
  local pidfile="$1" name="$2"
  if [[ -f "$pidfile" ]]; then
    local pid all_pids waited=0
    pid="$(cat "$pidfile")"
    # shellcheck disable=SC2046
    all_pids="$pid $(collect_descendants "$pid")"

    local any_alive=0 p
    for p in $all_pids; do
      kill -0 "$p" 2>/dev/null && any_alive=1
    done

    if [[ "$any_alive" -eq 1 ]]; then
      log_step "Stopping ${name} (pid ${pid} and its child processes)..."
      kill -TERM $all_pids 2>/dev/null || true

      while (( waited < 10 )); do
        local still_alive=0
        for p in $all_pids; do
          kill -0 "$p" 2>/dev/null && still_alive=1
        done
        [[ "$still_alive" -eq 0 ]] && break
        sleep 1
        waited=$(( waited + 1 ))
      done

      # Recompute descendants (in case any re-parented) before the final sweep.
      # shellcheck disable=SC2046
      all_pids="$pid $(collect_descendants "$pid")"
      local remaining=()
      for p in $all_pids; do
        kill -0 "$p" 2>/dev/null && remaining+=("$p")
      done
      if [[ "${#remaining[@]}" -gt 0 ]]; then
        log_warn "${name} did not stop gracefully — sending SIGKILL to: ${remaining[*]}"
        kill -KILL "${remaining[@]}" 2>/dev/null || true
      fi
      log_success "${name} stopped."
    fi
  fi
  rm -f "$pidfile"
}

# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------
wait_for_http() {
  local url="$1" timeout="$2" interval="$3" label="$4"
  local waited=0
  while (( waited < timeout )); do
    if curl -fsS -m 5 -o /dev/null "$url" 2>/dev/null; then
      log_success "${label} is healthy (${url})"
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
  done
  log_error "${label} did not become healthy within ${timeout}s (${url})"
  return 1
}

check_backend_health() {
  local port="$1" log_hint="$2"
  if wait_for_http "http://localhost:${port}/health" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL" "Backend API"; then
    local body
    body="$(curl -fsS -m 5 "http://localhost:${port}/health" 2>/dev/null || echo '{}')"
    if command -v jq >/dev/null 2>&1; then
      echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
      echo "$body"
    fi
    return 0
  fi
  if [[ -f "$log_hint" ]]; then
    log_warn "Last 40 lines of ${log_hint}:"
    tail -n 40 "$log_hint" || true
  fi
  return 1
}

check_frontend_reachable() {
  local port="$1"
  wait_for_http "http://localhost:${port}/" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL" "Frontend dev server"
}

# ---------------------------------------------------------------------------
# Dev mode
# ---------------------------------------------------------------------------
start_dev() {
  mkdir -p "$PID_DIR"
  cd "$REPO_ROOT"
  configure_local_kubeconfig

  if pid_file_running "$PID_DIR/api.pid" && port_in_use "$BACKEND_PORT"; then
    log_success "Backend dev server already running (pid $(cat "$PID_DIR/api.pid"))."
    if confirm "Restart it?" "N"; then
      stop_pid "$PID_DIR/api.pid" "backend dev server"
    fi
  fi
  if ! pid_file_running "$PID_DIR/api.pid"; then
    ensure_port_free "$BACKEND_PORT" "backend API" "$PID_DIR/api.pid" || return 1
    log_step "Starting backend dev server (npx nx serve velero-ui-api) on port ${BACKEND_PORT}..."
    PORT="$BACKEND_PORT" nohup npx nx serve velero-ui-api 200>&- > "$LOG_DIR/api-dev.log" 2>&1 &
    echo $! > "$PID_DIR/api.pid"
    disown
  fi

  if pid_file_running "$PID_DIR/ui.pid" && port_in_use "$FRONTEND_PORT"; then
    log_success "Frontend dev server already running (pid $(cat "$PID_DIR/ui.pid"))."
    if confirm "Restart it?" "N"; then
      stop_pid "$PID_DIR/ui.pid" "frontend dev server"
    fi
  fi
  if ! pid_file_running "$PID_DIR/ui.pid"; then
    ensure_port_free "$FRONTEND_PORT" "frontend dev server" "$PID_DIR/ui.pid" || return 1
    log_step "Starting frontend dev server (npx nx serve velero-ui) on port ${FRONTEND_PORT}..."
    load_env_into_shell
    VITE_PORT="$FRONTEND_PORT" nohup npx nx serve velero-ui 200>&- > "$LOG_DIR/ui-dev.log" 2>&1 &
    echo $! > "$PID_DIR/ui.pid"
    disown
  fi

  echo "dev" > "$STATE_DIR/last-mode"
  persist_ports

  local ok=0
  check_backend_health "$BACKEND_PORT" "$LOG_DIR/api-dev.log" || ok=1
  check_frontend_reachable "$FRONTEND_PORT" || ok=1

  if [[ "$ok" -ne 0 ]]; then
    log_error "One or more dev services failed their health check. See logs above."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Prod mode
# ---------------------------------------------------------------------------
build_app() {
  cd "$REPO_ROOT"
  local main_js="$REPO_ROOT/dist/apps/velero-ui/main.js"

  if [[ -f "$main_js" ]]; then
    local newer
    newer="$(find apps libs package-lock.json -newer "$main_js" 2>/dev/null | head -1 || true)"
    if [[ -z "$newer" ]]; then
      log_success "Build artifacts already up to date (dist/apps/velero-ui/main.js is newer than sources) — skipping rebuild."
      if ! confirm "Force a rebuild anyway?" "N"; then
        return 0
      fi
    fi
  fi

  log_step "Building production bundle (npx nx build velero-ui --prod)..."
  if npx nx build velero-ui --prod 2>&1 | tee "$LOG_DIR/build.log"; then
    log_success "Build complete: dist/apps/velero-ui"
    return 0
  fi
  log_error "Build failed. See ${LOG_DIR}/build.log for details."
  return 1
}

run_prod_node() {
  mkdir -p "$PID_DIR"
  cd "$REPO_ROOT"
  configure_local_kubeconfig

  if pid_file_running "$PID_DIR/prod.pid" && port_in_use "$BACKEND_PORT"; then
    log_success "Production (node) process already running (pid $(cat "$PID_DIR/prod.pid"))."
    if confirm "Restart it?" "N"; then
      stop_pid "$PID_DIR/prod.pid" "production node process"
    fi
  fi
  if ! pid_file_running "$PID_DIR/prod.pid"; then
    ensure_port_free "$BACKEND_PORT" "production app" "$PID_DIR/prod.pid" || return 1
    log_step "Starting production app (node dist/apps/velero-ui/main.js) on port ${BACKEND_PORT}..."
    # Must run with CWD = repo root: @nestjs/config's ConfigModule loads .env from
    # process.cwd(), not from the dist/ directory main.js physically lives in.
    PORT="$BACKEND_PORT" NODE_ENV=production nohup node dist/apps/velero-ui/main.js 200>&- > "$LOG_DIR/prod-node.log" 2>&1 &
    echo $! > "$PID_DIR/prod.pid"
    disown
  fi

  echo "prod-node" > "$STATE_DIR/last-mode"
  persist_ports
  check_backend_health "$BACKEND_PORT" "$LOG_DIR/prod-node.log"
}

run_prod_docker() {
  cd "$REPO_ROOT"

  local existing
  existing="$(docker ps -a --filter "name=^/${DOCKER_CONTAINER_NAME}$" --format '{{.Names}}:{{.Status}}' 2>/dev/null || true)"

  if docker image inspect "${DOCKER_IMAGE}:latest" >/dev/null 2>&1; then
    log_success "Docker image ${DOCKER_IMAGE}:latest already exists."
    if confirm "Rebuild it?" "N"; then
      log_step "Building Docker image..."
      docker build -t "$DOCKER_IMAGE" . 2>&1 | tee "$LOG_DIR/docker-build.log"
    fi
  else
    log_step "Building Docker image (docker build -t ${DOCKER_IMAGE} .)..."
    docker build -t "$DOCKER_IMAGE" . 2>&1 | tee "$LOG_DIR/docker-build.log"
  fi

  if [[ -n "$existing" ]]; then
    if [[ "$existing" == *"Up "* ]]; then
      log_success "Container '${DOCKER_CONTAINER_NAME}' is already running."
      if confirm "Recreate it (stop, remove, run fresh)?" "N"; then
        docker rm -f "$DOCKER_CONTAINER_NAME" >/dev/null
      else
        echo "prod-docker" > "$STATE_DIR/last-mode"
        persist_ports
        check_backend_health "$DOCKER_HOST_PORT" "$LOG_DIR/docker-run.log"
        return $?
      fi
    else
      log_info "Container '${DOCKER_CONTAINER_NAME}' exists but is stopped — starting it."
      if docker start "$DOCKER_CONTAINER_NAME" >/dev/null 2>"$LOG_DIR/docker-run.log"; then
        echo "prod-docker" > "$STATE_DIR/last-mode"
        persist_ports
        check_backend_health "$DOCKER_HOST_PORT" "$LOG_DIR/docker-run.log"
        return $?
      fi
      log_warn "Existing '${DOCKER_CONTAINER_NAME}' container failed to start (its saved config is likely stale —"
      log_warn "e.g. a bind-mounted file/volume path from a previous run no longer exists on this host):"
      tail -n 5 "$LOG_DIR/docker-run.log" || true
      if confirm "Remove the broken container and create a fresh one?" "Y"; then
        docker rm -f "$DOCKER_CONTAINER_NAME" >/dev/null
      else
        log_error "Leaving the broken container in place. Remove it manually with: docker rm -f ${DOCKER_CONTAINER_NAME}"
        return 1
      fi
    fi
  fi

  # The official docker.md command uses a normal bridge network + -p mapping.
  # That breaks when the kubeconfig's cluster server is 127.0.0.1/localhost
  # (kind/minikube/k3d): inside a bridge-networked container, that address is
  # the container's own loopback, not the host's, so it can never reach the
  # cluster. On Linux we can compensate with --network host (the container
  # then shares the host's network stack directly, so -p mapping is replaced
  # by telling the app to listen on DOCKER_HOST_PORT itself via PORT=).
  local net_args=() port_args=()
  if [[ "$OS_FAMILY" == "linux" ]] && kube_server_is_loopback; then
    log_info "kubeconfig points at a loopback address (127.0.0.1/localhost) — typical of a local cluster"
    log_info "such as kind/minikube/k3d. Using 'docker run --network host' so the container can reach it"
    log_info "(a normal bridge-networked container cannot reach the host's loopback interface)."
    net_args=(--network host -e "PORT=${DOCKER_HOST_PORT}")
  else
    port_args=(-p "${DOCKER_HOST_PORT}:3000")
  fi

  log_step "Running Docker container (matches the official docker.md command$( [[ ${#net_args[@]} -gt 0 ]] && echo ', adapted with --network host for local-cluster compatibility' ))..."
  docker run --name "$DOCKER_CONTAINER_NAME" \
    -v ~/.kube/config:/app/.kube/config \
    -e KUBE_CONFIG_PATH=/app/.kube/config \
    -d "${net_args[@]}" "${port_args[@]}" \
    "${DOCKER_IMAGE}:latest" 2>&1 | tee "$LOG_DIR/docker-run.log"

  echo "prod-docker" > "$STATE_DIR/last-mode"
  persist_ports
  check_backend_health "$DOCKER_HOST_PORT" "$LOG_DIR/docker-run.log"
}

prod_mode() {
  build_app || return 1

  local target="$PROD_TARGET"
  if [[ -z "$target" ]]; then
    if is_tty && [[ "$ASSUME_YES" -eq 0 ]]; then
      echo "Choose production execution target:"
      echo "  1) node   — run the built app directly with 'node' (no Docker needed)"
      echo "  2) docker — build and run the official Docker image"
      read -r -p "Choice [1/2]: " choice
      case "$choice" in
        2) target="docker" ;;
        *) target="node" ;;
      esac
    else
      log_error "Non-interactive --prod run needs --prod-target=node or --prod-target=docker."
      return 1
    fi
  fi

  case "$target" in
    node) run_prod_node ;;
    docker)
      check_docker || { log_error "Docker is required for --prod-target=docker."; return 1; }
      run_prod_docker
      ;;
    *) log_error "Unknown prod target: $target"; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Optional Kubernetes / Helm deploy (never implied, only via explicit flags)
# ---------------------------------------------------------------------------
k8s_deploy() {
  cd "$REPO_ROOT"
  log_step "Applying raw Kubernetes manifests (kubectl apply -f kubernetes/manifests)..."
  kubectl apply -f kubernetes/manifests

  mkdir -p "$PID_DIR"
  if pid_file_running "$PID_DIR/portforward.pid"; then
    log_success "Port-forward already running (pid $(cat "$PID_DIR/portforward.pid"))."
  else
    log_step "Starting port-forward: service/velero-ui ${DOCKER_HOST_PORT}:80 -n velero-ui..."
    nohup kubectl port-forward service/velero-ui "${DOCKER_HOST_PORT}:80" -n velero-ui 200>&- > "$LOG_DIR/portforward.log" 2>&1 &
    echo $! > "$PID_DIR/portforward.pid"
    disown
  fi
  check_backend_health "$DOCKER_HOST_PORT" "$LOG_DIR/portforward.log"
}

helm_deploy() {
  log_warn "SECURITY NOTE: the official Helm chart binds the 'cluster-admin' ClusterRole to velero-ui's"
  log_warn "service account by default (rbac.clusterAdministrator: true). This grants broad cluster access."
  log_warn "Review kubernetes/chart/values.yaml before deploying to a shared/production cluster."
  if ! confirm "Proceed with Helm install/upgrade into namespace 'velero-ui'?" "N"; then
    log_warn "Helm deploy skipped."
    return 1
  fi

  log_step "Adding/updating the otwld Helm repo..."
  helm repo add otwld https://helm.otwld.com/ >/dev/null 2>&1 || true
  helm repo update

  log_step "Ensuring namespace 'velero-ui' exists..."
  kubectl create namespace velero-ui --dry-run=client -o yaml | kubectl apply -f -

  log_step "Installing/upgrading the velero-ui Helm release..."
  helm upgrade --install velero-ui otwld/velero-ui --namespace velero-ui
  log_success "Helm release applied. Use 'kubectl get pods -n velero-ui' to check rollout status."
}

# ---------------------------------------------------------------------------
# Lifecycle: stop / restart / status
# ---------------------------------------------------------------------------
do_stop() {
  log_step "Stopping all script-managed services..."
  stop_pid "$PID_DIR/api.pid" "backend dev server"
  stop_pid "$PID_DIR/ui.pid" "frontend dev server"
  stop_pid "$PID_DIR/prod.pid" "production node process"
  stop_pid "$PID_DIR/portforward.pid" "kubectl port-forward"

  if command -v docker >/dev/null 2>&1 && docker ps --filter "name=^/${DOCKER_CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -q "$DOCKER_CONTAINER_NAME"; then
    log_step "Stopping Docker container '${DOCKER_CONTAINER_NAME}'..."
    docker stop "$DOCKER_CONTAINER_NAME" >/dev/null
    log_success "Docker container stopped."
  fi
  log_success "All managed services stopped."
}

do_restart() {
  do_stop
  local last_mode
  last_mode="$(cat "$STATE_DIR/last-mode" 2>/dev/null || echo "")"
  if [[ -n "$MODE" ]]; then
    last_mode="$MODE"
  fi
  case "$last_mode" in
    dev) start_dev ;;
    prod-node) PROD_TARGET="node" prod_mode ;;
    prod-docker) PROD_TARGET="docker" prod_mode ;;
    *)
      log_error "No previous mode recorded and none given — specify --dev or --prod."
      return 1
      ;;
  esac
}

do_status() {
  log_step "Status"
  local any=0

  if pid_file_running "$PID_DIR/api.pid"; then
    log_success "Backend dev server: running (pid $(cat "$PID_DIR/api.pid"), port ${BACKEND_PORT})"
    any=1
  fi
  if pid_file_running "$PID_DIR/ui.pid"; then
    log_success "Frontend dev server: running (pid $(cat "$PID_DIR/ui.pid"), port ${FRONTEND_PORT})"
    any=1
  fi
  if pid_file_running "$PID_DIR/prod.pid"; then
    log_success "Production (node) process: running (pid $(cat "$PID_DIR/prod.pid"), port ${BACKEND_PORT})"
    any=1
  fi
  if pid_file_running "$PID_DIR/portforward.pid"; then
    log_success "kubectl port-forward: running (pid $(cat "$PID_DIR/portforward.pid"))"
    any=1
  fi
  if command -v docker >/dev/null 2>&1; then
    local dstat
    dstat="$(docker ps --filter "name=^/${DOCKER_CONTAINER_NAME}$" --format '{{.Status}}' 2>/dev/null || true)"
    if [[ -n "$dstat" ]]; then
      log_success "Docker container '${DOCKER_CONTAINER_NAME}': ${dstat}"
      any=1
    fi
  fi

  if [[ "$any" -eq 0 ]]; then
    log_warn "Nothing appears to be running (no known pid files or containers active)."
  fi

  local last_mode
  last_mode="$(cat "$STATE_DIR/last-mode" 2>/dev/null || echo "unknown")"
  print_summary "$last_mode"
}

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
print_summary() {
  local mode="${1:-unknown}"
  local backend_url="http://localhost:${BACKEND_PORT}"
  local frontend_line="N/A — in production the backend serves the built frontend itself (no separate port)"
  local health_url="$backend_url/health"

  case "$mode" in
    dev)
      frontend_line="http://localhost:${FRONTEND_PORT}"
      ;;
    prod-docker)
      backend_url="http://localhost:${DOCKER_HOST_PORT}"
      health_url="$backend_url/health"
      ;;
  esac

  local health_status="unknown"
  if curl -fsS -m 5 -o /dev/null "$health_url" 2>/dev/null; then
    health_status="OK"
  else
    health_status="FAIL / unreachable"
  fi

  local kube_ctx="not configured"
  local kube_reachable="unreachable"
  if command -v kubectl >/dev/null 2>&1; then
    kube_ctx="$(kubectl config current-context 2>/dev/null || echo 'not configured')"
    kubectl cluster-info --request-timeout=3s >/dev/null 2>&1 && kube_reachable="reachable"
  fi

  local velero_ns="velero"
  [[ -f "$REPO_ROOT/.env" ]] && velero_ns="$(grep -E '^VELERO_NAMESPACE=' "$REPO_ROOT/.env" | cut -d= -f2- || echo 'velero')"
  [[ -z "$velero_ns" ]] && velero_ns="velero"

  local secret_status="customized"
  if [[ -f "$REPO_ROOT/.env" ]] && grep -q '^AUTH_SECRET_PASSPHRASE="this is not a secret passphrase"' "$REPO_ROOT/.env" 2>/dev/null; then
    secret_status="the insecure default — CHANGE THIS before real use"
  fi

  cat <<EOF

════════════════════════════════════════════════════════════════
  Velero UI — Startup Summary   (mode: ${mode})
════════════════════════════════════════════════════════════════
 Frontend URL    : ${frontend_line}
 Backend/API URL : ${backend_url}
   - API routes are prefixed with /api  (e.g. ${backend_url}/api/backups)
   - Health check (unprefixed): ${health_url}   [${health_status}]

 Kubernetes / Velero
   - Context      : ${kube_ctx}
   - Cluster API  : ${kube_reachable}
   - Velero ns    : ${velero_ns}
   Note: this project has no traditional database — all data is read live from the
   Kubernetes API (Velero CRDs). The /health check above IS the correct database-
   equivalent health check (it validates both Kubernetes and Velero connectivity).

 API Documentation: not available (no Swagger/OpenAPI endpoint exists in this codebase).
   General project docs: https://velero-ui.docs.otwld.com

 Default credentials (active when BASIC_AUTH_ENABLED=true, the default):
   Username: admin   Password: admin
   SECURITY WARNING: change BASIC_AUTH_PASSWORD and AUTH_SECRET_PASSPHRASE in .env
   before exposing this instance beyond local/trusted use.
   AUTH_SECRET_PASSPHRASE is currently: ${secret_status}

 Logs
   - This run  : ${RUN_LOG}
   - Backend   : ${LOG_DIR}/api-dev.log (dev) / ${LOG_DIR}/prod-node.log / ${LOG_DIR}/docker-run.log
   - Frontend  : ${LOG_DIR}/ui-dev.log (dev only)
   - Build     : ${LOG_DIR}/build.log (prod only)

 Manage this instance:
   ./startup.sh --status     Show current state and re-run health checks
   ./startup.sh --stop       Stop all script-managed processes/containers
   ./startup.sh --restart    Stop then restart in the same mode
════════════════════════════════════════════════════════════════
EOF
}

# ---------------------------------------------------------------------------
# Interactive menu (no flags given)
# ---------------------------------------------------------------------------
interactive_menu() {
  echo "Velero UI bootstrap — choose an option:"
  echo "  1) Development mode"
  echo "  2) Production mode"
  echo "  3) Status"
  echo "  4) Stop"
  echo "  5) Exit"
  read -r -p "Choice [1-5]: " choice
  case "$choice" in
    1) MODE="dev"; start_dev ;;
    2) MODE="prod"; prod_mode ;;
    3) do_status ;;
    4) do_stop ;;
    *) log_info "Exiting."; exit 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  load_persisted_ports

  if [[ "$ACTION" == "help" ]]; then
    usage
    exit 0
  fi

  log_init
  detect_os
  note_go_not_applicable

  if [[ "$ACTION" != "status" ]]; then
    acquire_lock
  fi

  ensure_repo

  case "$ACTION" in
    stop) do_stop ;;
    restart) do_restart ;;
    status) do_status ;;
    run)
      check_git
      check_node
      check_npm

      install_deps
      setup_env_file

      case "$MODE" in
        dev) start_dev ;;
        prod)
          [[ "$PROD_TARGET" == "docker" ]] && check_docker
          prod_mode
          ;;
        "") interactive_menu ;;
      esac

      if [[ "$DO_K8S_DEPLOY" -eq 1 ]]; then
        check_kubectl && check_kube_access
        k8s_deploy
      fi
      if [[ "$DO_HELM_DEPLOY" -eq 1 ]]; then
        check_kubectl && check_helm && check_kube_access
        helm_deploy
      fi

      local final_mode
      final_mode="$(cat "$STATE_DIR/last-mode" 2>/dev/null || echo "$MODE")"
      print_summary "$final_mode"
      ;;
  esac
}

main "$@"
