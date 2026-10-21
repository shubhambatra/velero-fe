import type { experimental } from '@grpc/grpc-js';

type CaListener = Parameters<experimental.CertificateProvider['addCaCertificateListener']>[0];
type IdentityListener = Parameters<
  experimental.CertificateProvider['addIdentityCertificateListener']
>[0];

/**
 * Feeds the gateway's TLS identity and the internal CA to grpc-js, and lets the
 * identity be replaced while the server is running.
 *
 * That last part is the reason this exists instead of `ServerCredentials.createSsl`:
 * the gateway's own certificate is short-lived, a control plane that has been up
 * for longer than it would otherwise stop accepting every agent at once, and
 * `createSsl` also cannot ask for a client certificate without *requiring* one,
 * which would make `Enroll` (no certificate yet) impossible on the same port.
 *
 * It uses grpc-js's `experimental` provider API, hence the exact-version pin in
 * `package.json` and the real-handshake tests in `gateway.e2e.test.ts`.
 */
export class GatewayIdentityProvider implements experimental.CertificateProvider {
  private identity: { certificate: Buffer; privateKey: Buffer } | null = null;
  private ca: { caCertificate: Buffer } | null = null;
  private readonly caListeners = new Set<CaListener>();
  private readonly identityListeners = new Set<IdentityListener>();

  /** Installs (or replaces) the identity and CA, notifying the live server. */
  set(identity: { certificatePem: string; privateKeyPem: string }, caPem: string): void {
    this.identity = {
      certificate: Buffer.from(identity.certificatePem),
      privateKey: Buffer.from(identity.privateKeyPem),
    };
    this.ca = { caCertificate: Buffer.from(caPem) };
    for (const listener of this.caListeners) {
      listener(this.ca);
    }
    for (const listener of this.identityListeners) {
      listener(this.identity);
    }
  }

  /**
   * grpc-js registers a server's watcher *after* it registers the provider
   * listeners, so a provider that answers synchronously reports the identity
   * before anyone is watching and the server never learns it has credentials
   * (it then drops every connection as "unloaded"). Answering on a microtask,
   * as the file-watching provider does, lets registration finish first.
   */
  private deliver(task: () => void): void {
    queueMicrotask(task);
  }

  addCaCertificateListener(listener: CaListener): void {
    this.caListeners.add(listener);
    this.deliver(() => {
      if (this.ca !== null && this.caListeners.has(listener)) {
        listener(this.ca);
      }
    });
  }

  removeCaCertificateListener(listener: CaListener): void {
    this.caListeners.delete(listener);
  }

  addIdentityCertificateListener(listener: IdentityListener): void {
    this.identityListeners.add(listener);
    this.deliver(() => {
      if (this.identity !== null && this.identityListeners.has(listener)) {
        listener(this.identity);
      }
    });
  }

  removeIdentityCertificateListener(listener: IdentityListener): void {
    this.identityListeners.delete(listener);
  }
}
