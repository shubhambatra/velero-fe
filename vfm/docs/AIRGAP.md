# Air-gapped installation

The product is designed to run with no route to the internet (principle P6): no CDN assets, no external fonts, no
telemetry, no runtime calls to a package registry, no breached-password API (the list is bundled), and agents
dial **out to your control plane**, never anywhere else. This guide is how to install it from a bundle, and what was and was
not verified.

## 1. What you need on the connected side

A machine with `docker`, `helm` and network access, and this repository checked out at the release you want:

```bash
# Build the control-plane and agent images (or pull a published release instead).
docker build -f vfm/server/Dockerfile -t ghcr.io/shubhambatra/vfm-control-plane:0.1.0 vfm   # from the repo root
docker build -t ghcr.io/shubhambatra/vfm-agent:0.1.0 vfm/agent

# Package both charts and save every image into one directory.
vfm/deploy/airgap/bundle.sh ./vfm-airgap-bundle
```

`bundle.sh` writes: both chart packages (`*.tgz`), `images.tar` (every image the charts deploy), `images.txt` (the list) and
`SHA256SUMS`. The list is **rendered from the charts** by `images.sh`, so it cannot drift from what they deploy. Run
`vfm/deploy/airgap/images.sh` alone to print it.

Not in the bundle, because they are yours: **PostgreSQL**, **Redis/Valkey**, your ingress controller, and **Velero**
(its server image, the object-storage plugin image and, if used, the node-agent) in each managed cluster. Mirror those the way
you mirror everything else; the dev environment pins the versions this release was tested with in
`deploy/dev/versions.env` (Velero v1.18.4 with the AWS plugin v1.14.4, supported down to v1.16.2).

## 2. Carry it across and load it

```bash
sha256sum -c SHA256SUMS                       # on the disconnected side

# Into a private registry (use skopeo, crane, or docker, whichever you have):
docker load -i images.tar
docker tag  ghcr.io/shubhambatra/vfm-control-plane:0.1.0 registry.internal/vfm/vfm-control-plane:0.1.0
docker push registry.internal/vfm/vfm-control-plane:0.1.0
# ...and the same for vfm-agent.
```

## 3. Install from the packages, pointing at your registry

```bash
helm upgrade --install vfm ./vfm-control-plane-0.1.0.tgz -n vfm-system --create-namespace \
  -f my-values.yaml \
  --set image.repository=registry.internal/vfm/vfm-control-plane \
  --set 'imagePullSecrets[0].name=internal-registry'
```

For each managed cluster, the **Add cluster** page prints the agent's install command. Change two things in it:
`vfm-agent` from the local package (`./vfm-agent-0.1.0.tgz`) instead of the `oci://` reference, and
`--set image.repository=registry.internal/vfm/vfm-agent`. The agent only ever connects to the address in
`controlPlane.address`, trusting only the CA you give it.

Two settings that matter in a closed network:

- `config.smtp.*` points at your internal relay (or leave it unset: invitations are then refused with 503, and you can add
  people through SSO instead).
- An identity provider on a private address needs `OIDC_ALLOW_PRIVATE=true`; webhook receivers on private addresses need
  `ALERT_WEBHOOK_ALLOW_PRIVATE=true` (both off by default so a user cannot aim the server at your network).

## 4. What was verified

`vfm/deploy/airgap/verify-airgap.sh` (needs docker and the images present locally; **it never pulls**):

1. creates a Docker network with `--internal` (no gateway to the outside) and **proves** `1.1.1.1` and `example.com` are unreachable from it;
2. starts PostgreSQL and a Redis with a password on it;
3. runs the migration with the chart's Job flags (read-only filesystem, no capabilities, non-root);
4. proves production mode **refuses** a Redis without a password, without printing the URL;
5. starts the control plane the way the chart does (production, read-only filesystem, all capabilities dropped, non-root) and waits for `/readyz`;
6. drives it: the UI is served with a strict CSP and no CDN or font host in the page, client-side routes survive a reload, the API's 404 is not the app, metrics are not on the public port; first-run setup, a setup token that works once, MFA enrolment, an organization, **Add cluster**, an agent that **enrols over TLS against the internal CA and connects over mTLS**, a bootstrap token that cannot enrol twice, `HelloAck`, the cluster reading `CONNECTED` with the Velero version the agent reported, the fleet overview;
7. proves the database password, the Redis password and the master key never appear in the log, and the one-time setup token appears exactly once (its banner).

Last run: 29 checks passed (19 in the driver) against the image built from this repository.

### What it does **not** prove

- It runs in Docker, **not in Kubernetes**: no `helm install` against a cluster, no image pull from a private registry, no
  NetworkPolicy enforcement, no Ingress or `LoadBalancer`. The chart is covered by rendered-manifest tests and `helm lint`,
  not by a cluster.
- The agent in the test is a protocol-level stand-in (the same enrol and Connect calls), **not the real Go agent**
  talking to a real Velero. The real agent has only been run against the real server in unit and integration tests.
- Velero's own air-gap needs (its images, plugins, object storage) are Velero's and untested here.
- Time must be in sync on both sides (certificates are checked against the clock); there is no NTP in a bundle.
