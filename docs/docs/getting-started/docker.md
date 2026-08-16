---
sidebar_position: 0
title: 🐳 Start with Docker
---
## 🚀 **Getting Started with Docker**

:::tip 🔑 **Credentials**

The default credentials to sign in are:

- **Username:** admin
- **Password:** admin

:::

<details>
<summary>🔧 **Before You Begin**</summary>

### 🛠 **Installing Docker**

#### 🖥️ For Windows and Mac Users:

- Download **Docker Desktop** from [Docker's official website](https://www.docker.com/products/docker-desktop).
- Follow the installation instructions provided. After installation, open **Docker Desktop** to ensure it's running properly.

#### 🐧 For Linux Users (Ubuntu, Debian, CentOS, etc.):

- Download **Docker** from [Docker's official website](https://docs.docker.com/engine/install/).
- Follow the installation instructions provided.

</details>

### ⚙️ **Installation**

1. Locate the path of your Kube Config. The default location is in `~/.kube/config`.

2. Run this Docker command with your Kube config path. You can also specify the context using the [environment variables](/getting-started/environment-variables) `KUBE_CONTEXT`:
    ```bash
    docker run --name velero-ui -v ~/.kube/config:/app/.kube/config -e KUBE_CONFIG_PATH=/app/.kube/config -d -p 3333:3000 otwld/velero-ui:latest
    ```
    Where:
      - **~/.kube/config:/app/.kube/config** links the Kube Config as a volume from the host to the container.
      - **KUBE_CONFIG_PATH=/app/.kube/config** is the path in the container to the Kube Config.

    If your Kube config contains multiple contexts (for example, several clusters), set `KUBE_CONTEXT` to the one you want
    Velero UI to use:
    ```bash
    docker run --name velero-ui -v ~/.kube/config:/app/.kube/config -e KUBE_CONFIG_PATH=/app/.kube/config -e KUBE_CONTEXT=my-context -d -p 3333:3000 otwld/velero-ui:latest
    ```

    :::tip 🌐 Connecting to a remote cluster
    The same mechanism works for any cluster reachable over the network, not just a local one — see
    [Connecting to a Remote Cluster](/getting-started/remote-cluster) for a full walkthrough, including recommended
    authentication.
    :::

### 📦 **Installation with Docker Compose**

1. Locate the path of your Kube Config, same as above.

2. Create a `docker-compose.yml` file (or use the one provided at the [root of the repository](https://github.com/otwld/velero-ui/blob/main/docker-compose.yml)):
    ```yaml
    services:
      velero-ui:
        image: otwld/velero-ui:latest
        container_name: velero-ui
        restart: unless-stopped
        ports:
          - "3333:3000"
        environment:
          KUBE_CONFIG_PATH: /app/.kube/config
          # KUBE_CONTEXT: my-context
        volumes:
          - ~/.kube/config:/app/.kube/config:ro
    ```

3. Start Velero UI:
    ```bash
    docker compose up -d
    ```
