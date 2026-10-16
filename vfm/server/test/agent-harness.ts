import 'reflect-metadata';

import { credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import * as x509 from '@peculiar/x509';

import type { ServerMessage } from '../src/gateway/pb/vfm/agent/v1/gateway';
import { AgentGatewayClient, AgentMessage } from '../src/gateway/pb/vfm/agent/v1/gateway';
import type { EnrollResponse } from '../src/gateway/pb/vfm/agent/v1/enrollment';

/** Helpers that play the agent against a real gateway; shared by the gateway and streams suites. */

export interface Keypair {
  csrPem: string;
  privateKeyPem: string;
}

export async function keypair(): Promise<Keypair> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString('pem'), privateKeyPem: pem };
}

/** The gRPC error a call rejects with; fails the test if it succeeds. */
export async function errorOf(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

export interface AgentCert {
  chain: string;
  key: string;
}

export function makeClient(
  port: number,
  caPem: string,
  cert?: AgentCert,
  clients?: AgentGatewayClient[],
): AgentGatewayClient {
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    cert === undefined ? null : Buffer.from(cert.key),
    cert === undefined ? null : Buffer.from(cert.chain),
  );
  const client = new AgentGatewayClient(`127.0.0.1:${port.toString()}`, creds, {
    'grpc.ssl_target_name_override': 'localhost',
  });
  clients?.push(client);
  return client;
}

export function enrollWith(
  client: AgentGatewayClient,
  token: string,
  csrPem: string,
  fingerprint: string,
): Promise<EnrollResponse> {
  return new Promise((resolve, reject) => {
    client.enroll(
      {
        bootstrapToken: token,
        csrPem: Buffer.from(csrPem),
        clusterFingerprint: fingerprint,
        agentVersion: '0.1.0',
        protocolVersion: 1,
      },
      (error, response) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(response);
        }
      },
    );
  });
}

export interface OpenStream {
  send: (message: Parameters<typeof AgentMessage.fromPartial>[0]) => void;
  /** The next server message, or rejects with the stream's end. */
  next: (timeoutMs?: number) => Promise<ServerMessage>;
  /** Resolves with how the stream ended: a status error, or 'eof' for a clean close. */
  ended: Promise<ServiceError | 'eof'>;
  end: () => void;
  cancel: () => void;
}

export function openStream(client: AgentGatewayClient): OpenStream {
  const stream = client.connect(new Metadata());
  const queue: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let outcome: ServiceError | 'eof' | undefined;
  let finish: (value: ServiceError | 'eof') => void = () => undefined;
  const ended = new Promise<ServiceError | 'eof'>((resolve) => {
    finish = resolve;
  });
  const wake = (): void => {
    for (const w of waiters.splice(0)) {
      w();
    }
  };

  stream.on('data', (message: ServerMessage) => {
    queue.push(message);
    wake();
  });
  stream.on('error', (error: ServiceError) => {
    outcome ??= error;
    finish(outcome);
    wake();
  });
  stream.on('end', () => {
    outcome ??= 'eof';
    finish(outcome);
    wake();
  });

  return {
    send: (message) => {
      stream.write(AgentMessage.fromPartial(message));
    },
    next: async (timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const message = queue.shift();
        if (message !== undefined) {
          return message;
        }
        if (outcome !== undefined) {
          throw new Error(
            `the stream ended before a message arrived: ${typeof outcome === 'string' ? outcome : outcome.details}`,
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error('timed out waiting for a server message');
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    ended,
    end: () => {
      stream.end();
    },
    cancel: () => {
      stream.cancel();
    },
  };
}

export const hello = (overrides: Record<string, unknown> = {}) => ({
  messageId: 'hello-1',
  hello: {
    protocolVersion: 1,
    agentVersion: '0.1.0',
    kubernetesVersion: 'v1.31.0',
    clusterFingerprint: 'f3a1c2d4-kube-system-uid-0001',
    velero: { serverVersion: 'v1.18.4', plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }] },
    capabilities: ['csi-data-mover'],
    policy: {
      allowRestore: true,
      restoreDeniedNamespaces: ['kube-system'],
      allowBslWrite: true,
      allowLogStreaming: true,
      logStreamDeniedNamespaces: [],
      readOnly: false,
    },
    ...overrides,
  },
});
