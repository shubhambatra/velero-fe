import {
  currentKubeContext,
  kubeContextMiddleware,
  runInKubeContext,
} from './kube-context';

describe('kube context', () => {
  const run = (header?: unknown): string | undefined => {
    let seen: string | undefined = 'unset';
    kubeContextMiddleware(
      { headers: { 'x-kube-context': header } } as never,
      {} as never,
      () => {
        seen = currentKubeContext();
      }
    );
    return seen;
  };

  it('takes the context from the X-Kube-Context header', () => {
    expect(run('prod')).toBe('prod');
  });

  it('is undefined (default cluster) without a usable header', () => {
    expect(run(undefined)).toBeUndefined();
    expect(run('')).toBeUndefined();
    expect(run(['a', 'b'])).toBeUndefined();
  });

  it('keeps concurrent requests apart, also across awaits', async () => {
    const read = async (name: string) =>
      runInKubeContext(name, async () => {
        await new Promise((r) => setTimeout(r, name === 'slow' ? 20 : 1));
        return currentKubeContext();
      });
    expect(await Promise.all([read('slow'), read('fast')])).toEqual([
      'slow',
      'fast',
    ]);
  });

  it('is unset outside a request', () => {
    expect(currentKubeContext()).toBeUndefined();
  });
});
