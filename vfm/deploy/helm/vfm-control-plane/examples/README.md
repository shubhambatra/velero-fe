# Exposing the control plane

Two different things need to be reachable, and they must **not** be exposed the same way.

| What | Protocol | Terminated at the proxy? |
|------|----------|--------------------------|
| UI and REST API (`:80` -> pod `:3000`) | HTTPS | yes, an ordinary Ingress or Gateway |
| **Agent gateway** (`-gateway` Service, `:8443`) | gRPC over **mTLS** | **no** - TCP/TLS passthrough |

The gateway asks every agent for a client certificate signed by the control plane's own CA and
authenticates the agent by it. A proxy that terminates TLS there would strip that certificate and no
agent could connect. An L7 balancer that cannot pass TLS through must be put in TCP (L4) mode.

* `ingress-nginx-https.yaml` - the UI/API through ingress-nginx.
* `gateway-api-tls-passthrough.yaml` - the agent gateway through Gateway API (`TLSRoute`).
* `loadbalancer-values.yaml` - the simplest: a `LoadBalancer` Service for the gateway.
* `ingress-nginx-passthrough.yaml` - the agent gateway through ingress-nginx (`--enable-ssl-passthrough`).
