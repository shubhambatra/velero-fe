# Velero UI (personal build)

> **Run the Fleet UI (default):** `docker compose up -d --build`, then open <http://localhost:3000>. It is the multi-cluster
> Velero Fleet Manager in [`vfm/`](./vfm/README.md), which has run instructions for every service. The original single-cluster
> UI is still available with `docker compose -f docker-compose.legacy.yml up -d` (port 3333).

A fully realtime lightweight dashboard interface to interact with [Velero (vmware-tanzu)](https://github.com/vmware-tanzu/velero), built on top of the excellent open-source [**otwld/velero-ui**](https://github.com/otwld/velero-ui) project.

> This repo is my personal working copy of velero-ui. I use it to learn/experiment with its Nx monorepo setup and to add features I needed that weren't in upstream yet.

## 🔧 What I added

- **Remote cluster support via kubeconfig context** — the dashboard can now connect to and manage a Velero instance on a remote Kubernetes cluster by selecting a `kubeconfig` context, instead of only working against the cluster it's running in.

Everything else below is the original velero-ui feature set, kept for reference.

![otwld_velero_ui_banner](./banner.png)

![GitHub License](https://img.shields.io/github/license/otwld/velero-ui)
[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/velero-ui)](https://artifacthub.io/packages/helm/otwld/velero-ui)
![Build Status](https://github.com/otwld/velero-ui/actions/workflows/apps-cd.yml/badge.svg)
[![Discord](https://img.shields.io/badge/Discord-OTWLD-blue?logo=discord&logoColor=white)](https://discord.gg/U24mpqTynB)
![Docker Image Version (latest semver)](https://img.shields.io/docker/v/otwld/velero-ui?label=docker%20image)
![Docker Image Size (tag)](https://img.shields.io/docker/image-size/otwld/velero-ui)

## 👀 Quick look

<img src="/images/screenshots.gif">

## ⭐ Velero UI Features

### Interface

- 🔒 **Authentication:** Secure dashboard with multiple authentication methods.
- 🔍 **Resource Management:** Search, sort, and perform quick actions on Velero resources.
- ⚠️ **Action Confirmation:** Double-check confirmation modals for critical actions.
- 🧩 **Intuitive Forms:** Step-by-step form wizard for easy resource creation and edition.
- 📄 **Detailed Resource Pages:** Each resource has a dedicated page displaying specifications, status, manifests, and logs.
- 🏳️ **Languages**: Multi languages are available.

### Authentication

- 🔑 **Built-in Authentication:** Velero UI is secured by default with username and password credentials.
- 🌐 **Federated Authentication:** Supports up to five external authentication providers, including GitHub, GitLab, Google, Microsoft, and generic OAuth/OpenID.
- 📂 **LDAP Integration:** Configure Velero UI to integrate with your existing LDAP system.
- 🔒 **Role Based Access Control:** Flexible RBAC system with user and group policies for granular access control.

### Statistics

- 📊 **Global Overview:** View summaries of your Velero resources (backups, schedules, restores, etc.).
- 📈 **Charts and Visualizations:** Track resource status and success rates with visual metrics.

### Advanced Settings

- 🖥️ **Cluster Info:** Access basic information about the cluster running the Velero Server.
- 📝 **Logs:** Real-time log monitoring for Velero Server and Node Agents.

### Technical

- ⚡ **Optimized Performance:** Velero UI leverages caching for fast performance and quick rendering.
- 📱 **Responsive Design:** Fully functional on mobile devices and tablets.

## 📋 Requirements

- **Velero server >= 1.13.0**

> ⚠️ This dashboard has only been tested on version **1.13.x**, **1.14.x**, **1.15.x** and **1.16.x**, using an older version may cause bugs with an outdated or
> unmanaged API

## 📚 Documentation

Want to learn more about Velero UI's features? Check out the original [Velero UI documentation](https://velero-ui.docs.otwld.com) for a comprehensive overview!

## 🚀 Deployments

- [🐳 **Getting Started with Docker**](https://velero-ui.docs.otwld.com/getting-started/docker)
- [☸️ **Getting Started with Helm Chart**](https://velero-ui.docs.otwld.com/getting-started/helm)
- [⚙️ **Getting Started with Kubernetes**](https://velero-ui.docs.otwld.com/getting-started/kubernetes)

## 🙏 Credits

All credit for the core project goes to [otwld/velero-ui](https://github.com/otwld/velero-ui) and its contributors. For questions about Velero itself, see the [Velero issue page](https://github.com/vmware-tanzu/velero/issues); for the upstream UI project, see the [Velero-ui issue page](https://github.com/otwld/velero-ui/issues) or their [Discord](https://discord.gg/U24mpqTynB).
