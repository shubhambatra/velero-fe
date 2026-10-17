import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Where an alert may be sent, and the one function that sends it (PLAN.md §12).
 *
 * An org admin names the URL, and this process runs inside the operator's network, so a
 * webhook is a way to make the control plane send a request to places the admin cannot reach
 * themselves (SSRF). Three rules follow, each checked here and nowhere else:
 *
 * - the **address that is connected to** is the one that was checked: the check happens in the
 *   socket's own `lookup`, so a name that resolves differently the second time (DNS
 *   rebinding) cannot slip past a check made earlier;
 * - any answer containing a blocked address refuses the name, rather than picking another;
 * - redirects are never followed, because a redirect is a second destination nobody checked.
 */

export interface EgressPolicy {
  allowPrivate: boolean;
  allowHttp: boolean;
}

export class EgressError extends Error {
  constructor(
    /** A fixed sentence, safe to store and show. */
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

const v4 = (ip: string): number[] | null => {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
};

/** An IPv6 address as 16 bytes, or null. Handles `::` and a trailing dotted quad. */
export function v6bytes(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad !== null) {
    const dotted = quad[1] as string;
    const parts = v4(dotted);
    if (parts === null) return null;
    const hex = (a: number, b: number): string => ((a << 8) | b).toString(16);
    text =
      text.slice(0, -dotted.length) +
      `${hex(parts[0] as number, parts[1] as number)}:${hex(parts[2] as number, parts[3] as number)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

const worst = (a: 'always' | 'private' | 'public', b: 'always' | 'private' | 'public') =>
  a === 'always' || b === 'always'
    ? 'always'
    : a === 'private' || b === 'private'
      ? 'private'
      : 'public';

/** `always`: never allowed. `private`: allowed only by policy. `public`: fine. */
export function classify(ip: string): 'always' | 'private' | 'public' {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = v4(ip) ?? [];
    if (a === 0 || a >= 224) return 'always'; // this network, multicast, reserved, broadcast
    if (a === 169 && b === 254) return 'always'; // link-local, including cloud metadata
    if (a === 127 || a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
    return 'public';
  }
  const bytes = v6bytes(ip);
  if (bytes === null) return 'always';
  const quad = (at: number): string => bytes.slice(at, at + 4).join('.');
  const zeroTo = (n: number): boolean => bytes.slice(0, n).every((x) => x === 0);
  if (bytes.every((x) => x === 0)) return 'always'; // ::
  if (zeroTo(15) && bytes[15] === 1) return 'private'; // ::1
  // Addresses that carry an IPv4 address inside: judged as that address, and never better
  // than "private" (a translator may reach anything the embedded address can).
  if (zeroTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return classify(quad(12)); // ::ffff:a.b.c.d
  if (zeroTo(12)) return worst(classify(quad(12)), 'private'); // ::a.b.c.d (deprecated)
  if (
    zeroTo(4) &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0xff &&
    bytes[7] === 0xff &&
    bytes.slice(8, 12).every((x) => x === 0)
  ) {
    return worst(classify(quad(12)), 'private'); // ::ffff:0:a.b.c.d
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((x) => x === 0)
  ) {
    return worst(classify(quad(12)), 'private'); // 64:ff9b::/96 NAT64
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return worst(classify(quad(2)), 'private'); // 6to4
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) return 'always'; // fe80::/10 link-local
  if (bytes[0] === 0xff) return 'always'; // multicast
  if (((bytes[0] as number) & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique local
  return 'public';
}

const allowed = (ip: string, policy: EgressPolicy): boolean => {
  const c = classify(ip);
  return c === 'public' || (c === 'private' && policy.allowPrivate);
};

/** A reason the URL can never be used, or null. Names are checked again, address by address, at send time. */
export function checkUrl(raw: string, policy: EgressPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'the URL is not valid';
  }
  if (raw.length > 2048) return 'the URL is too long';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    return url.protocol === 'http:'
      ? 'plain http is not allowed here; use https'
      : 'the URL must use https';
  }
  if (url.username !== '' || url.password !== '') {
    return 'the URL must not contain a user name or password';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return 'the URL has no host';
  if (net.isIP(host) !== 0 && !allowed(host, policy)) {
    return 'that address is not allowed as a destination';
  }
  if (
    !policy.allowPrivate &&
    (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))
  ) {
    return 'that address is not allowed as a destination';
  }
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` that refuses a name with any disallowed address. Exported for tests. */
export function guardedLookup(policy: EgressPolicy, resolve = dns.lookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error);
        return;
      }
      const list = addresses;
      if (list.length === 0 || list.some((a) => !allowed(a.address, policy))) {
        const refused: NodeJS.ErrnoException = new Error('destination not allowed');
        refused.code = 'EVFMDENIED';
        callback(refused);
        return;
      }
      if (options.all === true) {
        callback(null, list);
      } else {
        const first = list[0] as dns.LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}

export interface PostResult {
  status: number;
}

const MAX_DRAIN = 4096;

/** A fixed sentence for what went wrong, never the URL or the library's own text. */
function describe(error: NodeJS.ErrnoException): EgressError {
  switch (error.code) {
    case 'EVFMDENIED':
      return new EgressError('the destination is not an allowed address', false);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new EgressError('the host name could not be resolved', true);
    case 'ECONNREFUSED':
      return new EgressError('the connection was refused', true);
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'ECONNRESET':
      return new EgressError('the connection timed out or was reset', true);
    default:
      return /certificate|SSL|TLS|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(
        `${error.code ?? ''} ${error.message}`,
      )
        ? new EgressError('the TLS certificate could not be verified', false)
        : new EgressError('the request could not be sent', true);
  }
}

/**
 * Sends one JSON POST. Resolves with the status for any 2xx; throws {@link EgressError}
 * otherwise (3xx included: redirects are not followed).
 */
export function postJson(
  raw: string,
  headers: Record<string, string>,
  body: string,
  policy: EgressPolicy,
  options: { timeoutMs?: number; lookup?: typeof dns.lookup } = {},
): Promise<PostResult> {
  const refusal = checkUrl(raw, policy);
  if (refusal !== null) {
    return Promise.reject(new EgressError(refusal, false));
  }
  const url = new URL(raw);
  const client = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<PostResult>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          'user-agent': 'velero-fleet-manager',
          ...headers,
        },
        lookup: guardedLookup(policy, options.lookup) as unknown as net.LookupFunction,
        // No connection reuse: a pooled socket would skip the lookup, and with it the check.
        agent: false,
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let drained = 0;
        response.on('data', (chunk: Buffer) => {
          drained += chunk.length;
          if (drained > MAX_DRAIN) response.destroy();
        });
        const finish = (): void => {
          if (status >= 200 && status < 300) {
            resolve({ status });
          } else if (status >= 300 && status < 400) {
            reject(
              new EgressError(
                'the destination answered with a redirect, which is not followed',
                false,
              ),
            );
          } else {
            reject(
              new EgressError(
                `the destination answered HTTP ${status.toString()}`,
                status >= 500 || status === 429 || status === 408,
              ),
            );
          }
        };
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', () => {
          finish();
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(describe(error));
    });
    request.end(body);
  });
}
