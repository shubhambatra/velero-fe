#!/usr/bin/env bash
# Prints every container image the two charts deploy, one per line, by rendering them (so the list can
# never drift from the charts). Needs only `helm`.
#
#   ./images.sh                      # images for the default chart versions
#   ./images.sh --set image.tag=1.2  # extra helm arguments are passed to BOTH charts
#
# Not listed, because they are yours: PostgreSQL, Redis/Valkey, your ingress controller, and Velero with
# its plugins and object storage in each managed cluster.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
charts="$here/../helm"
ca="$(mktemp)"; trap 'rm -f "$ca"' EXIT
printf -- '-----BEGIN CERTIFICATE-----\nMIIBabc+/=\n-----END CERTIFICATE-----\n' > "$ca"
{
  helm template vfm "$charts/vfm-control-plane" \
    --set secrets.existingSecret=x --set gateway.publicAddress=vfm.invalid:8443 \
    --set migrations.enabled=true "$@"
  helm template agent "$charts/vfm-agent" \
    --set controlPlane.address=vfm.invalid:8443 --set-file controlPlane.caBundle="$ca" "$@"
} | sed -n 's/^[[:space:]]*image:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' | sort -u
