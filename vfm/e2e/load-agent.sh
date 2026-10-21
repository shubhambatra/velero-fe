#!/usr/bin/env bash
# Builds the agent image from the working tree, loads it into the kind cluster under a UNIQUE tag, and points the
# running agent release at it.
#
# A unique tag because loading a second image under the same tag on the same day can leave the node with the
# old one (containerd's import name is per day), and the symptom, an agent that lacks your change, is baffling.
#
#   e2e/load-agent.sh            # needs the agent release installed (golden.mjs GP1 does that)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="${VFM_KUBE_CONTEXT:-kind-vfm-a}"; CLUSTER="${VFM_KIND_CLUSTER:-vfm-a}"
tag="e2e-$(date +%s)"
docker build -q -t "ghcr.io/shubhambatra/vfm-agent:$tag" --build-arg VERSION="$tag" "$here/../agent" >/dev/null
kind load docker-image "ghcr.io/shubhambatra/vfm-agent:$tag" --name "$CLUSTER" >/dev/null
helm upgrade vfm-agent "$here/../deploy/helm/vfm-agent" --kube-context "$CTX" -n vfm-system --reuse-values --set image.tag="$tag" >/dev/null
kubectl --context "$CTX" -n vfm-system rollout status deployment/vfm-agent --timeout=180s
echo "agent now runs ghcr.io/shubhambatra/vfm-agent:$tag"
