# Velero Fleet Manager — developer entrypoints (PLAN.md §4.5).
#
# Every target either does its job or fails loudly with the missing prerequisite.
# Nothing here silently "succeeds" by skipping work.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

VFM_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DEV_DIR  := $(VFM_ROOT)/deploy/dev
AGENT_DIR := $(VFM_ROOT)/agent

# pnpm comes from the version pinned in package.json via corepack, so the
# repo-root npm/Nx workspace is never involved (DECISIONS.md ADR-004).
export COREPACK_ENABLE_DOWNLOAD_PROMPT := 0
PNPM := corepack pnpm

# Velero release this build targets (DECISIONS.md ADR-002).
VELERO_PRIMARY := v1.18.4
VELERO_OLDEST  := v1.16.2

# require-tool,<binary>,<how to install it>
define require-tool
@command -v $(1) >/dev/null 2>&1 || { \
	printf '\nmissing prerequisite: %s\n  install: %s\n\n' '$(1)' '$(2)' >&2; \
	exit 1; \
}
endef

.PHONY: help
help: ## List available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: doctor
doctor: ## Report which prerequisites are present
	@printf '%-16s %s\n' 'tool' 'version'
	@for t in node corepack docker kind kubectl helm velero go buf golangci-lint; do \
		if command -v "$$t" >/dev/null 2>&1; then \
			printf '%-16s %s\n' "$$t" "$$($$t version 2>/dev/null || $$t --version 2>/dev/null | head -1)"; \
		else \
			printf '%-16s %s\n' "$$t" 'MISSING'; \
		fi; \
	done

.PHONY: setup
setup: ## Install workspace dependencies
	$(call require-tool,corepack,ships with Node >= 22)
	cd $(VFM_ROOT) && $(PNPM) install

.PHONY: gen
gen: gen-proto ## Run every code generator (proto, OpenAPI, API client)
	@if [ -f $(VFM_ROOT)/server/package.json ]; then \
		cd $(VFM_ROOT) && $(PNPM) --filter @vfm/server --if-present run gen; \
	else \
		echo 'gen: server workspace not present yet (M0 day 3) — skipping OpenAPI emit'; \
	fi

.PHONY: gen-proto
gen-proto: ## Generate Go and TypeScript stubs from proto/
	$(call require-tool,buf,https://github.com/bufbuild/buf/releases)
	@if ! ls $(VFM_ROOT)/proto/vfm/agent/v1/*.proto >/dev/null 2>&1; then \
		echo 'gen-proto: no .proto files yet (M2 day 10) — skipping codegen'; \
	else \
		cd $(VFM_ROOT)/proto && buf generate; \
	fi

.PHONY: lint
lint: lint-ts lint-go lint-proto ## Lint everything

.PHONY: lint-ts
lint-ts: ## Lint and format-check the TypeScript workspaces
	$(call require-tool,corepack,ships with Node >= 22)
	cd $(VFM_ROOT) && $(PNPM) run lint

.PHONY: lint-go
lint-go: ## Lint the Go agent module
	@if [ ! -f $(AGENT_DIR)/go.mod ]; then \
		echo 'lint-go: agent module not present yet (M0 day 3) — skipping'; \
	else \
		command -v golangci-lint >/dev/null 2>&1 || { \
			echo 'missing prerequisite: golangci-lint' >&2; \
			echo '  install: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest' >&2; \
			exit 1; \
		}; \
		cd $(AGENT_DIR) && golangci-lint run ./...; \
	fi

.PHONY: lint-proto
lint-proto: ## Lint proto definitions
	$(call require-tool,buf,https://github.com/bufbuild/buf/releases)
	cd $(VFM_ROOT)/proto && buf lint

.PHONY: lint-staged
lint-staged: ## Pre-commit hook entrypoint (see .husky/pre-commit at the repo root)
	cd $(VFM_ROOT) && $(PNPM) run lint

.PHONY: test
test: test-ts test-go ## Run all unit tests

.PHONY: test-ts
test-ts: ## Run TypeScript unit tests
	$(call require-tool,corepack,ships with Node >= 22)
	cd $(VFM_ROOT) && $(PNPM) run test

.PHONY: test-go
test-go: ## Run Go unit tests
	@if [ ! -f $(AGENT_DIR)/go.mod ]; then \
		echo 'test-go: agent module not present yet (M0 day 3) — skipping'; \
	else \
		command -v go >/dev/null 2>&1 || { \
			echo 'missing prerequisite: go' >&2; \
			echo '  install: https://go.dev/dl/ (1.27.2 or newer)' >&2; \
			exit 1; \
		}; \
		cd $(AGENT_DIR) && go test ./...; \
	fi

.PHONY: e2e
e2e: ## Run the Playwright end-to-end suite
	@if [ ! -f $(VFM_ROOT)/e2e/package.json ]; then \
		echo 'e2e: suite not present yet (M2) — nothing to run'; \
	else \
		cd $(VFM_ROOT) && $(PNPM) --filter @vfm/e2e run test; \
	fi

.PHONY: build
build: ## Build all deployable artifacts
	$(call require-tool,corepack,ships with Node >= 22)
	cd $(VFM_ROOT) && $(PNPM) run build
	@if [ -f $(AGENT_DIR)/go.mod ]; then \
		cd $(AGENT_DIR) && go build -o bin/agent ./cmd/agent; \
	fi

.PHONY: dev-up
dev-up: ## Bring up the full local dev environment (compose + kind clusters)
	$(DEV_DIR)/scripts/dev-up.sh

.PHONY: dev-down
dev-down: ## Tear down the local dev environment
	$(DEV_DIR)/scripts/dev-down.sh

.PHONY: smoke
smoke: ## Assert a Velero backup completes on both dev kind clusters
	$(DEV_DIR)/scripts/smoke.sh

.PHONY: helm-lint
helm-lint: ## Lint the Helm charts
	$(call require-tool,helm,https://helm.sh/docs/intro/install/)
	@found=0; \
	for chart in $(VFM_ROOT)/deploy/helm/*/Chart.yaml; do \
		[ -e "$$chart" ] || continue; \
		found=1; \
		helm lint "$$(dirname "$$chart")"; \
	done; \
	if [ "$$found" = 0 ]; then \
		echo 'helm-lint: no charts yet (agent chart lands in M2 day 15) — nothing to lint'; \
	fi

.PHONY: versions
versions: ## Print the pinned Velero support window
	@echo "VELERO_PRIMARY=$(VELERO_PRIMARY)"
	@echo "VELERO_OLDEST=$(VELERO_OLDEST)"
