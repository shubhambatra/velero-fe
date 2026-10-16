import 'reflect-metadata';

import { X509Certificate } from 'node:crypto';

import * as x509 from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_CERT_LIFETIME_MS,
  CertificateError,
  generateCa,
  issueServerCertificate,
  loadCa,
  signAgentCsr,
  spiffeIdFor,
  verifyClientCertificate,
  type CaMaterial,
} from './ca';

const CLUSTER = '0194f9d2-0000-7000-8000-00000000c001';

async function csr(curve: 'P-256' | 'P-384' = 'P-256', name = 'CN=whatever'): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ]);
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: curve === 'P-256' ? 'SHA-256' : 'SHA-384' },
    extensions: [
      // An agent asking to be somebody else; must be ignored.
      new x509.SubjectAlternativeNameExtension([
        { type: 'url', value: spiffeIdFor('0194f9d2-0000-7000-8000-00000000dead') },
      ]),
    ],
  });
  return request.toString('pem');
}

const leaf = (pem: string): Buffer => Buffer.from(new X509Certificate(pem).raw);

describe('internal CA', () => {
  let ca: CaMaterial;

  beforeAll(async () => {
    const generated = await generateCa();
    ca = await loadCa(generated.certificatePem, generated.privateKeyPkcs8);
  });

  it('creates a constrained, self-signed CA', async () => {
    const generated = await generateCa();
    const cert = new X509Certificate(generated.certificatePem);
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.subject).toContain('VFM Internal CA');
  });

  it('issues a 7-day client certificate with exactly the control plane’s identity', async () => {
    const issued = await signAgentCsr(ca, await csr(), CLUSTER);
    const cert = new X509Certificate(issued.certificatePem);

    expect(cert.subjectAltName).toBe(`URI:${spiffeIdFor(CLUSTER)}`);
    expect(cert.subjectAltName).not.toContain('dead');
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.2');
    expect(issued.notAfter.getTime() - Date.now()).toBeGreaterThan(AGENT_CERT_LIFETIME_MS - 60_000);
    expect(issued.notAfter.getTime() - Date.now()).toBeLessThanOrEqual(AGENT_CERT_LIFETIME_MS);
    expect(issued.serial).toBe(cert.serialNumber.toLowerCase());
  });

  it('gives every certificate its own serial', async () => {
    const request = await csr();
    const a = await signAgentCsr(ca, request, CLUSTER);
    const b = await signAgentCsr(ca, request, CLUSTER);
    expect(a.serial).not.toBe(b.serial);
  });

  it('refuses a key that is not ECDSA P-256', async () => {
    await expect(signAgentCsr(ca, await csr('P-384'), CLUSTER)).rejects.toThrow(/ECDSA P-256/);
  });

  it('refuses garbage and a CSR whose signature has been tampered with', async () => {
    await expect(signAgentCsr(ca, 'not a csr', CLUSTER)).rejects.toBeInstanceOf(CertificateError);

    const pem = await csr();
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    der[der.length - 3] = (der[der.length - 3] ?? 0) ^ 0xff;
    const forged = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
    await expect(signAgentCsr(ca, forged, CLUSTER)).rejects.toBeInstanceOf(CertificateError);
  });

  describe('verifying a presented certificate', () => {
    it('accepts one it issued and recovers the cluster and serial', async () => {
      const issued = await signAgentCsr(ca, await csr(), CLUSTER);
      const verified = verifyClientCertificate(ca, leaf(issued.certificatePem));
      expect(verified.clusterId).toBe(CLUSTER);
      expect(verified.serial).toBe(issued.serial);
    });

    it('refuses a certificate from another CA, even with the right identity', async () => {
      const other = await generateCa();
      const otherCa = await loadCa(other.certificatePem, other.privateKeyPkcs8);
      const forged = await signAgentCsr(otherCa, await csr(), CLUSTER);
      expect(() => verifyClientCertificate(ca, leaf(forged.certificatePem))).toThrow(
        /not issued by this control plane/,
      );
    });

    it('refuses an expired and a not-yet-valid certificate', async () => {
      const issued = await signAgentCsr(ca, await csr(), CLUSTER);
      const der = leaf(issued.certificatePem);
      const later = new Date(Date.now() + AGENT_CERT_LIFETIME_MS + 3_600_000);
      expect(() => verifyClientCertificate(ca, der, later)).toThrow(/validity period/);
      expect(() => verifyClientCertificate(ca, der, new Date(Date.now() - 3_600_000))).toThrow(
        /validity period/,
      );
    });

    it('refuses the gateway’s own server certificate as a client identity', async () => {
      const server = await issueServerCertificate(ca, ['localhost', '127.0.0.1']);
      expect(() => verifyClientCertificate(ca, leaf(server.certificatePem))).toThrow(
        CertificateError,
      );
    });

    it('refuses garbage bytes', () => {
      expect(() => verifyClientCertificate(ca, Buffer.from('nope'))).toThrow(CertificateError);
    });
  });

  it('issues a server certificate that chains to the CA and names every host', async () => {
    const server = await issueServerCertificate(ca, ['gateway.example.com', '10.0.0.5']);
    const cert = new X509Certificate(server.certificatePem);
    const issuer = new X509Certificate(Buffer.from(ca.certificate.rawData));
    expect(cert.verify(issuer.publicKey)).toBe(true);
    expect(cert.checkHost('gateway.example.com')).toBeDefined();
    expect(cert.checkIP('10.0.0.5')).toBeDefined();
    expect(server.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });
});
