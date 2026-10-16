# The Velero Fleet Manager agent image (PLAN.md §4.1: distroless, non-root, read-only).
#
# Build context is this directory (vfm/agent):
#   docker build -t ghcr.io/shubhambatra/vfm-agent:dev --build-arg VERSION=dev .
#
# Both base images are pinned by digest so a rebuild cannot change under us; bump
# them deliberately (and re-run govulncheck) rather than by floating a tag.

FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS build
WORKDIR /src
# Dependencies first, so a source-only change reuses the layer.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
# Static, stripped, reproducible paths. CGO is off: the image has no libc.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/vfm-agent ./cmd/agent

FROM gcr.io/distroless/static-debian12@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/vfm-agent /vfm-agent
# 65532 is distroless's "nonroot"; the chart sets the same id.
USER 65532:65532
EXPOSE 8081 9090
ENTRYPOINT ["/vfm-agent"]
