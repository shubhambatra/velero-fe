# The Velero Fleet Manager control plane image: REST API, agent gateway and the built web UI.
#
# Build context is the workspace root (vfm/):
#   docker build -f server/Dockerfile -t ghcr.io/shubhambatra/vfm-control-plane:dev .
#
# Non-root, read-only-root-filesystem friendly (the chart mounts /tmp), no package manager at run
# time, and no network access needed to RUN it. The base image is pinned by digest (BASE_IMAGE);
# bump it deliberately and re-run the image scan rather than floating a tag.

ARG BASE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${BASE_IMAGE} AS build
ENV CI=true
WORKDIR /src
RUN corepack enable
# Dependency manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
# Scripts off here: workspace postinstall steps need sources that are not copied yet. The native
# dependencies (argon2, Prisma engines, esbuild, swc) are rebuilt below, once the sources exist.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY server server
COPY web web
RUN pnpm rebuild \
 && pnpm --filter @vfm/server exec prisma generate \
 && pnpm --filter @vfm/shared build \
 && pnpm --filter @vfm/server build \
 && pnpm --filter @vfm/web build
# Only what runs: the server's production dependencies. The Prisma CLI comes with them (it is a peer
# of @prisma/client) and does two jobs: generating the client now (a fresh install has none), and
# `migrate deploy` for the Helm pre-upgrade Job later. No database is needed to generate.
RUN pnpm --filter @vfm/server deploy --prod --legacy /out \
 && rm -rf /out/src /out/test \
 && cd /out && node node_modules/prisma/build/index.js generate

FROM ${BASE_IMAGE} AS run
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /out/package.json ./package.json
COPY --from=build --chown=65532:65532 /src/server/dist ./dist
# The schema and migrations: the Helm pre-upgrade Job runs `node node_modules/prisma/build/index.js migrate deploy` here.
COPY --from=build --chown=65532:65532 /out/prisma ./prisma
COPY --from=build --chown=65532:65532 /out/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=65532:65532 /src/web/dist ./web
USER 65532:65532
EXPOSE 3000 8443 9090
ENTRYPOINT ["node", "dist/main.js"]
