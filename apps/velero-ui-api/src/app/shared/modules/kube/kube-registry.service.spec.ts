import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KubeRegistry } from './kube-registry.service';

const kubeconfig = (
  context: string,
  user: Record<string, unknown> = { token: 't' },
  cluster = {}
) =>
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      { name: 'c', cluster: { server: 'https://10.0.0.1:6443', ...cluster } },
    ],
    users: [{ name: 'u', user }],
    contexts: [{ name: context, context: { cluster: 'c', user: 'u' } }],
    'current-context': context,
  });

describe('KubeRegistry', () => {
  let dir: string;
  let file: string;

  const registry = (values: Record<string, string | undefined> = {}) =>
    new KubeRegistry({
      get: (key: string) => ({ 'k8s.configPath': file, ...values })[key],
    } as unknown as ConfigService);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kube-registry-'));
    file = join(dir, 'kubeconfig');
    writeFileSync(file, kubeconfig('alpha'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the contexts of the managed file and marks the default', () => {
    expect(registry().list()).toEqual([
      { name: 'alpha', server: 'https://10.0.0.1:6443', isDefault: true },
    ]);
  });

  it('refuses to start when the requested default context does not exist', () => {
    expect(() => registry({ 'k8s.context': 'missing' })).toThrow(
      /KUBE_CONTEXT "missing"/
    );
  });

  it('seeds the managed file from the host kubeconfig on first start only', () => {
    const seed = join(dir, 'host');
    writeFileSync(seed, kubeconfig('from-host'));
    file = join(dir, 'managed');

    expect(registry({ 'k8s.seedPath': seed }).names()).toEqual(['from-host']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(seed, 'utf8')).toBe(kubeconfig('from-host'));
  });

  it('returns a separate KubeConfig per context and rejects unknown ones', () => {
    const r = registry();
    r.add(kubeconfig('beta'));

    expect(r.get('alpha').getCurrentContext()).toBe('alpha');
    expect(r.get('beta').getCurrentContext()).toBe('beta');
    expect(r.get().getCurrentContext()).toBe('alpha');
    expect(() => r.get('nope')).toThrow(BadRequestException);
  });

  describe('add', () => {
    it('persists the new context with its own cluster and user entries', () => {
      const r = registry();
      expect(r.add(kubeconfig('beta'))).toEqual(['beta']);

      const reloaded = registry();
      expect(reloaded.names()).toEqual(['alpha', 'beta']);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('rejects a duplicate context name', () => {
      expect(() => registry().add(kubeconfig('alpha'))).toThrow(
        ConflictException
      );
    });

    it.each([
      [
        'exec credentials',
        kubeconfig('x', { exec: { command: 'sh', apiVersion: 'v1' } }),
      ],
      [
        'auth-provider credentials',
        kubeconfig('x', { 'auth-provider': { name: 'gcp' } }),
      ],
      [
        'a client certificate path',
        kubeconfig('x', { 'client-certificate': '/etc/cert' }),
      ],
      ['a client key path', kubeconfig('x', { 'client-key': '/etc/key' })],
      [
        'a CA path',
        kubeconfig('x', { token: 't' }, { 'certificate-authority': '/etc/ca' }),
      ],
      [
        'a non-http server',
        kubeconfig('x', { token: 't' }, { server: 'file:///etc/passwd' }),
      ],
    ])('rejects %s', (_label, input) => {
      expect(() => registry().add(input)).toThrow(BadRequestException);
      expect(registry().names()).toEqual(['alpha']);
    });

    it('rejects unparseable input and a kubeconfig without contexts', () => {
      expect(() => registry().add('not: [yaml')).toThrow(BadRequestException);
      expect(() => registry().add('apiVersion: v1\nkind: Config\n')).toThrow(
        BadRequestException
      );
    });

    it('is refused without a managed file', () => {
      expect(() =>
        registry({ 'k8s.configPath': undefined }).add(kubeconfig('beta'))
      ).toThrow();
    });
  });

  describe('remove', () => {
    it('drops the context and its orphaned cluster and user', () => {
      const r = registry();
      r.add(kubeconfig('beta'));
      r.remove('beta');

      expect(registry().names()).toEqual(['alpha']);
      expect(readFileSync(file, 'utf8')).not.toContain('beta');
    });

    it('rejects unknown contexts', () => {
      expect(() => registry().remove('nope')).toThrow(NotFoundException);
    });
  });
});
