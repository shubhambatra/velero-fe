import 'reflect-metadata';

import { randomBytes, X509Certificate, type webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

/**
 * The internal certificate authority's cryptography (PLAN.md §5.1), kept free
 * of I/O so every rule can be tested without a database.
 *
 * ECDSA P-256 throughout: it is what the agent generates, it keeps handshakes
 * cheap for 200 long-lived streams, and fixing one algorithm removes a whole
 * class of "which key type did we accept" questions.
 */

type CryptoKey = webcrypto.CryptoKey;

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNATURE_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export const AGENT_CERT_LIFETIME_MS = 7 * 24 * 3_600_000;
export const CA_LIFETIME_MS = 10 * 365 * 24 * 3_600_000;
export const SERVER_CERT_LIFETIME_MS = 30 * 24 * 3_600_000;
/** Allow for clock skew between the control plane and a cluster's nodes. */
const BACKDATE_MS = 5 * 60_000;

const SPIFFE_PREFIX = 'spiffe://vfm/cluster/';

export const spiffeIdFor = (clusterId: string): string => `${SPIFFE_PREFIX}${clusterId}`;

/** Widens a value the typings call non-optional but the runtime may omit. */
const maybe = <T>(value: T): T | undefined => value;

export class CertificateError extends Error {}

export interface CaMaterial {
  certificate: x509.X509Certificate;
  privateKey: CryptoKey;
}

export interface IssuedCertificate {
  certificatePem: string;
  /** Lower-case hex, no leading zeros stripped beyond the first byte. */
  serial: string;
  notBefore: Date;
  notAfter: Date;
}

/** Random positive serial: 16 bytes with the top bit cleared. */
function newSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  if (bytes[0] === 0) {
    bytes[0] = 1;
  }
  return bytes.toString('hex');
}

const subjectKeyId = (
  publicKey: CryptoKey | x509.PublicKey,
): Promise<x509.SubjectKeyIdentifierExtension> =>
  x509.SubjectKeyIdentifierExtension.create(publicKey, false);

export async function generateCa(now: Date = new Date()): Promise<{
  certificatePem: string;
  privateKeyPkcs8: Buffer;
  notAfter: Date;
}> {
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const notAfter = new Date(now.getTime() + CA_LIFETIME_MS);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: newSerial(),
    name: 'CN=VFM Internal CA,O=Velero Fleet Manager',
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter,
    signingAlgorithm: SIGNATURE_ALGORITHM,
    keys,
    extensions: [
      // pathLen 0: this CA signs leaves only and can never mint a sub-CA.
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await subjectKeyId(keys.publicKey),
    ],
  });
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
    notAfter,
  };
}

export async function loadCa(certificatePem: string, privateKeyPkcs8: Buffer): Promise<CaMaterial> {
  const certificate = new x509.X509Certificate(certificatePem);
  const privateKey = await crypto.subtle.importKey('pkcs8', privateKeyPkcs8, KEY_ALGORITHM, false, [
    'sign',
  ]);
  return { certificate, privateKey };
}

/**
 * Signs the public key from an agent's CSR.
 *
 * **Nothing in the CSR except the public key is trusted.** The subject, SANs and
 * requested extensions are ignored: the agent does not get to choose who it is,
 * the control plane stamps `spiffe://vfm/cluster/{clusterId}` itself. The CSR's
 * self-signature is still checked, which proves the requester holds the private
 * key for the key being certified.
 */
export async function signAgentCsr(
  ca: CaMaterial,
  csrPem: string,
  clusterId: string,
  now: Date = new Date(),
): Promise<IssuedCertificate> {
  const csr = await parseCsr(csrPem);
  const notBefore = new Date(now.getTime() - BACKDATE_MS);
  const notAfter = new Date(now.getTime() + AGENT_CERT_LIFETIME_MS);
  const serial = newSerial();

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject: `CN=vfm-agent ${clusterId}`,
    issuer: ca.certificate.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNATURE_ALGORITHM,
    signingKey: ca.privateKey,
    publicKey: csr.publicKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
      new x509.SubjectAlternativeNameExtension([{ type: 'url', value: spiffeIdFor(clusterId) }]),
      await subjectKeyId(csr.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.certificate, false),
    ],
  });

  return { certificatePem: certificate.toString('pem'), serial, notBefore, notAfter };
}

async function parseCsr(csrPem: string): Promise<x509.Pkcs10CertificateRequest> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new CertificateError('the certificate request could not be parsed');
  }
  const algorithm = csr.publicKey.algorithm as { name?: string; namedCurve?: string };
  if (algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256') {
    throw new CertificateError('the certificate request must use an ECDSA P-256 key');
  }
  if (!(await csr.verify())) {
    throw new CertificateError('the certificate request signature is invalid');
  }
  return csr;
}

/**
 * Issues the gateway's own TLS certificate so agents can pin the internal CA
 * instead of trusting a public one.
 */
export async function issueServerCertificate(
  ca: CaMaterial,
  hostnames: readonly string[],
  now: Date = new Date(),
): Promise<{ certificatePem: string; privateKeyPem: string; notAfter: Date }> {
  if (hostnames.length === 0) {
    throw new CertificateError('a server certificate needs at least one hostname');
  }
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const notAfter = new Date(now.getTime() + SERVER_CERT_LIFETIME_MS);
  const isIp = (value: string): boolean => /^[0-9.]+$/.test(value) || value.includes(':');

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: newSerial(),
    subject: `CN=${hostnames[0] ?? 'vfm-gateway'}`,
    issuer: ca.certificate.subject,
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter,
    signingAlgorithm: SIGNATURE_ALGORITHM,
    signingKey: ca.privateKey,
    publicKey: keys.publicKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
      new x509.SubjectAlternativeNameExtension(
        hostnames.map((value) => ({ type: isIp(value) ? 'ip' : 'dns', value }) as const),
      ),
      await subjectKeyId(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.certificate, false),
    ],
  });

  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { certificatePem: certificate.toString('pem'), privateKeyPem, notAfter };
}

export interface VerifiedClientCertificate {
  clusterId: string;
  serial: string;
  notAfter: Date;
}

const UUID_TAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Checks a presented client certificate against the CA: signature, validity
 * window, client-auth usage and the SPIFFE identity. It does **not** consult the
 * deny-list; the caller does, because that needs the database.
 *
 * Accepts DER, which is what the TLS layer hands over.
 */
export function verifyClientCertificate(
  ca: CaMaterial,
  der: Buffer,
  now: Date = new Date(),
): VerifiedClientCertificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    throw new CertificateError('the client certificate could not be parsed');
  }

  const issuer = new X509Certificate(Buffer.from(ca.certificate.rawData));
  if (!cert.verify(issuer.publicKey) || !cert.checkIssued(issuer)) {
    throw new CertificateError('the client certificate was not issued by this control plane');
  }

  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (now < notBefore || now > notAfter) {
    throw new CertificateError('the client certificate is not within its validity period');
  }

  // Both are absent (undefined) at runtime when the extension is missing, which
  // the Node typings do not admit.
  const san = maybe(cert.subjectAltName);
  const usages = maybe(cert.keyUsage);

  const uris = [...(san ?? '').matchAll(/URI:([^,\s]+)/g)].map((m) => m[1] ?? '');
  const identities = uris.filter((uri) => uri.startsWith(SPIFFE_PREFIX));
  const clusterId = identities[0]?.slice(SPIFFE_PREFIX.length) ?? '';
  if (identities.length !== 1 || !UUID_TAIL.test(clusterId)) {
    throw new CertificateError(
      'the client certificate does not carry exactly one cluster identity',
    );
  }

  if (cert.ca || !(usages ?? []).includes('1.3.6.1.5.5.7.3.2')) {
    throw new CertificateError('the certificate is not a client-authentication leaf');
  }

  return { clusterId, serial: cert.serialNumber.toLowerCase(), notAfter };
}
