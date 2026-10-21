#!/usr/bin/env bash
# Builds the offline bundle: both charts packaged, and every image saved to a tarball.
#
#   ./bundle.sh [output-dir]      (default: ./vfm-airgap-bundle)
#
# Run it on a machine WITH internet access, carry the directory across, then on the other side:
#   docker load -i images.tar            (or: skopeo copy docker-archive:images.tar docker://REGISTRY/...)
#   helm install ... ./vfm-control-plane-<version>.tgz
# See docs/AIRGAP.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-vfm-airgap-bundle}"
mkdir -p "$out"
helm package "$here/../helm/vfm-control-plane" --destination "$out"
helm package "$here/../helm/vfm-agent" --destination "$out"
"$here/images.sh" > "$out/images.txt"
echo "images:"; sed 's/^/  /' "$out/images.txt"
while read -r image; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
done < "$out/images.txt"
# shellcheck disable=SC2046
docker save -o "$out/images.tar" $(cat "$out/images.txt")
( cd "$out" && sha256sum ./*.tgz images.tar images.txt > SHA256SUMS )
echo "bundle written to $out"; ls -lh "$out"
