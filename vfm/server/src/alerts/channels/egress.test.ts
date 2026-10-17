import type dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkUrl, classify, EgressError, guardedLookup, postJson } from './egress';

const strict = { allowPrivate: false, allowHttp: false };
const lax = { allowPrivate: true, allowHttp: true };

describe('classify', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['100.63.0.1', 'public'],
    ['2606:4700::1111', 'public'],
    ['127.0.0.1', 'private'],
    ['127.255.255.254', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['198.18.0.1', 'private'],
    ['::1', 'private'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['169.254.169.254', 'always'],
    ['169.254.0.1', 'always'],
    ['::ffff:169.254.169.254', 'always'],
    ['0.0.0.0', 'always'],
    ['0.1.2.3', 'always'],
    ['224.0.0.1', 'always'],
    ['255.255.255.255', 'always'],
    ['::', 'always'],
    ['fe80::1', 'always'],
    ['ff02::1', 'always'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:808:808', 'public'],
    ['::ffff:a9fe:a9fe', 'always'],
    ['::a00:1', 'private'],
    ['::808:808', 'private'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'always'],
    ['64:ff9b::808:808', 'private'],
    ['2002:a00:1::1', 'private'],
    ['2002:a9fe:a9fe::1', 'always'],
    ['0:0:0:0:0:0:0:1', 'private'],
    ['FE80::1', 'always'],
    ['2001:db8::1', 'public'],
    ['not an ip', 'always'],
  ])('%s is %s', (ip, expected) => {
    expect(classify(ip)).toBe(expected);
  });
});

describe('checkUrl', () => {
  it('accepts an https URL to a public name', () => {
    expect(checkUrl('https://hooks.slack.com/services/T0/B0/xyz', strict)).toBeNull();
  });

  it.each([
    ['not a url', /not valid/],
    ['ftp://example.com/x', /https/],
    ['http://example.com/x', /plain http/],
    ['https://user:pw@example.com/x', /user name/],
    ['https://127.0.0.1/x', /not allowed/],
    ['https://10.0.0.5/x', /not allowed/],
    ['https://[::1]/x', /not allowed/],
    ['https://[fd00::1]/x', /not allowed/],
    ['https://[::ffff:10.0.0.1]/x', /not allowed/],
    ['https://[::ffff:127.0.0.1]/x', /not allowed/],
    ['https://[::ffff:169.254.169.254]/x', /not allowed/],
    ['https://2130706433/x', /not allowed/],
    ['https://0x7f.1/x', /not allowed/],
    ['https://017700000001/x', /not allowed/],
    ['https://169.254.169.254/latest/meta-data', /not allowed/],
    ['https://localhost/x', /not allowed/],
    ['https://app.localhost/x', /not allowed/],
    [`https://example.com/${'a'.repeat(2100)}`, /too long/],
  ])('refuses %s by default', (url, why) => {
    expect(checkUrl(url, strict)).toMatch(why);
  });

  it('allows private networks and plain http only when told to, and never the metadata address', () => {
    expect(checkUrl('http://10.0.0.5:8080/hook', lax)).toBeNull();
    expect(checkUrl('https://localhost:8443/hook', lax)).toBeNull();
    expect(checkUrl('http://169.254.169.254/x', lax)).toMatch(/not allowed/);
    expect(checkUrl('https://[fe80::1]/x', lax)).toMatch(/not allowed/);
    expect(checkUrl('http://10.0.0.5/x', { allowPrivate: true, allowHttp: false })).toMatch(
      /plain http/,
    );
    expect(checkUrl('https://10.0.0.5/x', { allowPrivate: false, allowHttp: true })).toMatch(
      /not allowed/,
    );
  });
});

describe('guardedLookup', () => {
  const answer = (...addresses: string[]): typeof dns.lookup =>
    ((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => {
      cb(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    }) as unknown as typeof dns.lookup;
  const run = (policy: typeof strict, resolver: typeof dns.lookup, all = false) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => {
      guardedLookup(policy, resolver)('x.test', { all }, (error, address) => {
        resolve({ error, address });
      });
    });

  it('passes a public answer through, as a list or as one address', async () => {
    expect((await run(strict, answer('93.184.216.34'))).address).toBe('93.184.216.34');
    expect(((await run(strict, answer('93.184.216.34'), true)).address as unknown[]).length).toBe(
      1,
    );
  });

  it('refuses a name that resolves to a private address, and one with any bad address among good ones', async () => {
    expect((await run(strict, answer('10.0.0.1'))).error?.code).toBe('EVFMDENIED');
    expect((await run(strict, answer('93.184.216.34', '127.0.0.1'))).error?.code).toBe(
      'EVFMDENIED',
    );
    expect((await run(strict, answer('169.254.169.254'))).error?.code).toBe('EVFMDENIED');
    expect((await run(lax, answer('169.254.169.254'))).error?.code).toBe('EVFMDENIED');
    expect((await run(lax, answer('10.0.0.1'))).error).toBeNull();
  });

  it('refuses an empty answer, and passes a resolver error on', async () => {
    expect((await run(strict, answer())).error?.code).toBe('EVFMDENIED');
    const failing = ((_h: string, _o: unknown, cb: (e: Error) => void) => {
      cb(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    }) as unknown as typeof dns.lookup;
    expect((await run(strict, failing)).error?.code).toBe('ENOTFOUND');
  });
});

describe('postJson', () => {
  let server: http.Server;
  let base = '';
  const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let mode = 'ok';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        if (mode === 'redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
        } else if (mode === '500') {
          res.writeHead(500).end('boom with secrets');
        } else if (mode === '400') {
          res.writeHead(400).end();
        } else if (mode === 'slow') {
          setTimeout(() => res.writeHead(200).end(), 500);
        } else {
          res.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
  });
  afterAll(() => {
    server.close();
  });

  it('posts the body with the headers and succeeds on 2xx', async () => {
    mode = 'ok';
    const result = await postJson(`${base}/hook`, { 'x-test': '1' }, '{"a":1}', lax);
    expect(result.status).toBe(204);
    const last = seen.at(-1);
    expect(last?.body).toBe('{"a":1}');
    expect(last?.headers['x-test']).toBe('1');
    expect(last?.headers['content-type']).toBe('application/json');
  });

  it('does not follow a redirect', async () => {
    mode = 'redirect';
    const before = seen.length;
    await expect(postJson(`${base}/hook`, {}, '{}', lax)).rejects.toMatchObject({
      message: expect.stringMatching(/redirect/),
      retryable: false,
    });
    expect(seen.length).toBe(before + 1);
  });

  it('says a 5xx is worth retrying and a 4xx is not, without echoing the body', async () => {
    mode = '500';
    const five = await postJson(`${base}/hook`, {}, '{}', lax).catch(
      (e: unknown) => e as EgressError,
    );
    expect(five).toMatchObject({ retryable: true, message: 'the destination answered HTTP 500' });
    expect((five as Error).message).not.toMatch(/secrets/);
    mode = '400';
    await expect(postJson(`${base}/hook`, {}, '{}', lax)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('times out', async () => {
    mode = 'slow';
    await expect(postJson(`${base}/hook`, {}, '{}', lax, { timeoutMs: 100 })).rejects.toMatchObject(
      {
        message: expect.stringMatching(/timed out/),
        retryable: true,
      },
    );
  });

  it('refuses a private destination by policy before any connection, and never names the URL', async () => {
    const before = seen.length;
    const error = await postJson(`${base}/hook?token=SECRET`, {}, '{}', strict).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(EgressError);
    expect((error as Error).message).not.toMatch(/SECRET|127\.0\.0\.1/);
    expect(seen.length).toBe(before);
  });

  it('refuses a name that resolves to a private address even with a public-looking URL', async () => {
    const rebind = ((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as unknown as typeof dns.lookup;
    const before = seen.length;
    await expect(
      postJson('https://hooks.example.test/x', {}, '{}', strict, { lookup: rebind }),
    ).rejects.toMatchObject({
      message: 'the destination is not an allowed address',
      retryable: false,
    });
    expect(seen.length).toBe(before);
  });

  it('reports an unresolvable name and a refused connection as such', async () => {
    const nx = ((_h: string, _o: unknown, cb: (e: Error) => void) => {
      cb(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    }) as unknown as typeof dns.lookup;
    await expect(
      postJson('https://nope.example.test/x', {}, '{}', strict, { lookup: nx }),
    ).rejects.toMatchObject({
      message: 'the host name could not be resolved',
    });
    await expect(postJson('http://127.0.0.1:1/x', {}, '{}', lax)).rejects.toMatchObject({
      message: 'the connection was refused',
    });
  });
});
