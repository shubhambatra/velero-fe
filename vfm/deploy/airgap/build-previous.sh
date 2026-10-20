#!/usr/bin/env bash
# Builds "the previous release" image for the upgrade rehearsal: the CURRENT packaging (Dockerfile, lockfile,
# chart) with the application code and database schema of an earlier commit. What an upgrade changes is
# the application code and the schema, which is what is swapped.
#
#   ./build-previous.sh <git-ref> [tag]       e.g. ./build-previous.sh 1ff13c9 vfm-control-plane:previous
set -euo pipefail
ref="${1:?usage: build-previous.sh <git-ref> [tag]}"
tag="${2:-vfm-control-plane:previous}"
root="$(git rev-parse --show-toplevel)"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
git -C "$root" archive HEAD vfm | tar -x -C "$ctx"
rm -rf "$ctx/vfm/server/src" "$ctx/vfm/server/prisma" "$ctx/vfm/packages/shared/src" "$ctx/vfm/server/scripts"
git -C "$root" archive "$ref" vfm/server/src vfm/server/prisma vfm/packages/shared/src | tar -x -C "$ctx"
# The old tree has no scripts/ and its tsconfig must not look for one.
docker build -f "$ctx/vfm/server/Dockerfile" -t "$tag" "$ctx/vfm"
echo "built $tag from $(git -C "$root" rev-parse --short "$ref") (code and schema) on today's packaging"
