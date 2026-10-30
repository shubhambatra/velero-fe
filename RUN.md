# How to run it, step by step

Two applications live in this repository. Run **A** (the Fleet Manager, the default) or **B** (the single-cluster Velero UI with the multi-cluster dashboard), or both; they use different ports.

|       | App                              | Open                                                          | Sign in                                                                          |
| ----- | -------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A** | Velero Fleet Manager             | <https://kube.dev-backup.in> (or <http://localhost:3000>)     | the admin you create on first run, plus two-step verification                    |
| **B** | Velero UI with cluster dashboard | <http://kube.dev-backup.in:3333> (or <http://localhost:3333>) | `admin` / `admin` unless you set `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` |

More detail, screenshots and troubleshooting for A: [`vfm/DOCUMENTATION.md`](./vfm/DOCUMENTATION.md).

## 0. Prerequisites

```bash
docker --version          # Docker 24 or newer
docker compose version    # Compose v2
```

Ports **3000** and **8443** (A) or **3333** (B) must be free. For B you also need Node 22 or newer (`node --version`) and a kubeconfig for the cluster(s) you want to manage.

Run every command from the repository root.

## Network and hostname: `kube.dev-backup.in`

Both stacks join one Docker network named `kube.dev-backup.in` (created by whichever stack starts first). A `caddy` service in the Fleet stack serves **https** on port 443 for that name with a self-signed certificate (plain http on port 80 redirects to it), and proxies to the control plane. Inside Docker nothing else is needed. To open the UI **by that name in your browser**, make it resolve to this machine once:

```bash
echo "127.0.0.1 kube.dev-backup.in" | sudo tee -a /etc/hosts
```

Then use <https://kube.dev-backup.in> (Fleet) and <http://kube.dev-backup.in:3333> (legacy). `localhost` keeps working. The ports are bound to this machine only; to reach them from other machines, change the `127.0.0.1:` bindings in `vfm/deploy/quickstart/compose.yml` and point the name at the machine's address.

### Trusting the self-signed certificate (optional)

The first visit shows a certificate warning, because the certificate comes from a throwaway CA that Caddy creates. Accept the warning once, or trust that CA so it goes away:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./kube-dev-backup-root.crt
# Ubuntu/Debian system store (curl, wget):
sudo cp kube-dev-backup-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

Chrome and Firefox keep their own store: import the file under Settings > Privacy and security > Manage certificates > Authorities. The CA is kept in the `caddydata` volume, so it survives restarts; deleting that volume creates a new one. The agent gateway (port 8443) is not behind Caddy: it uses its own mTLS certificate.

---

## A. Fleet Manager

### 1. Start it

```bash
docker compose up -d --build
docker compose ps          # control-plane, postgres and valkey should be Up / healthy
```

The first build takes a few minutes. If the control plane exits with `getaddrinfo EAI_AGAIN postgres`, run `docker compose down` (no `-v`) and `docker compose up -d` again.

### 2. Get the one-time setup token

```bash
docker compose logs control-plane | grep -ao 'token\\":\\"[A-Za-z0-9_-]*' | sed 's/.*\\"//'
```

Copy the printed value. It is only needed once, to create the first admin.

### 3. Create the admin

Open <http://localhost:3000>, paste the setup token on the setup page, and choose an email and a password of at least 12 characters.

### 4. Sign in and enrol two-step verification

Sign in with that email and password. The first sign-in asks you to register an authenticator app (scan the QR code or type the key), then enter the 6-digit code. Every later sign-in asks for a code.

### 5. Create an organization

Open **New organization** in the sidebar (or <http://localhost:3000/admin/orgs/new>), enter a name and a slug, and press **Create organization**.

### 6. Add a cluster

1. Go to **Clusters** and press **Add cluster**. Enter a name and confirm with your own sign-in password (and a code if asked).
2. The page shows an **install command** with a one-time token. Copy it.
3. Run that command on the Kubernetes cluster you want to manage, with `kubectl` pointing at that cluster. Velero must already be installed there.
4. After a minute the cluster shows **Connected**.

The install command contains `controlPlane.address=localhost:8443`. For a cluster that is not on this machine, set an address the cluster can reach **before** you press Add cluster: see Step 8 in `vfm/DOCUMENTATION.md` (section 2).

### 7. Stop or restart

```bash
docker compose stop        # stop, keep data
docker compose up -d       # start again
docker compose down        # remove containers, keep data (volumes)
```

Do not add `-v` unless you want to delete the database, which removes every user and cluster.

---

## B. Velero UI with the multi-cluster dashboard

### 1. Install and build

```bash
npm install
NX_LOAD_DOT_ENV_FILES=false npx nx run-many -t build -p velero-ui velero-ui-api
```

`NX_LOAD_DOT_ENV_FILES=false` matters: a root `.env` with `VITE_API_URL` would otherwise be baked into the bundle and the page would stay blank.

### 2. Start it

```bash
docker compose -f docker-compose.legacy.yml up -d --build
docker compose -f docker-compose.legacy.yml ps
```

Your `~/.kube/config` is mounted read-only and copied once into the `velero-ui-data` volume. That copy is the list of clusters the dashboard manages; your original file is never changed.

### 3. Use it

1. Open <http://localhost:3333> and sign in (`admin` / `admin` by default).
2. You land on **Clusters**: one card per context in the kubeconfig.
3. Click a card to open the Velero UI for that cluster. **Clusters** in the header returns to the dashboard.
4. **Add cluster**: paste a whole kubeconfig. Tokens or client-certificate data must be embedded; `exec`, `auth-provider` and file-path credentials are rejected. Use the trash icon to remove a cluster (nothing on the cluster is touched).

A kind cluster's kubeconfig points at `127.0.0.1`, which a container cannot reach. Generate an internal one and join the `kind` network:

```bash
kind get kubeconfig --internal --name <cluster> > tmp/kubeconfig-internal
```

Mount that file instead of `~/.kube/config` with a local `docker-compose.legacy.override.yml` that also adds `networks: [kind]` (external network `kind`).

### 4. Stop or restart

```bash
docker compose -f docker-compose.legacy.yml stop
docker compose -f docker-compose.legacy.yml up -d
docker compose -f docker-compose.legacy.yml down      # keeps the data volume
```

`down -v` also deletes the volume and with it every cluster you added in the UI.
