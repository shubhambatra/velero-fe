import { describe, expect, it, vi } from 'vitest';

import { startTracing, withSpan } from './tracing';

describe('tracing hook', () => {
  it('is a transparent no-op without an SDK: returns the value and rethrows the error', async () => {
    await expect(withSpan('x', { 'vfm.op': 'A' }, () => Promise.resolve(7))).resolves.toBe(7);
    await expect(withSpan('x', {}, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });

  it('does nothing, and loads nothing, when disabled', async () => {
    const load = vi.fn();
    const stop = await startTracing(false, load);
    await stop();
    expect(load).not.toHaveBeenCalled();
  });

  it('starts the SDK when enabled and stops it on shutdown', async () => {
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    class NodeSDK {
      start = start;
      shutdown = shutdown;
    }
    const stop = await startTracing(true, () => Promise.resolve({ NodeSDK }));
    expect(start).toHaveBeenCalledOnce();
    await stop();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('stays off, without failing startup, when the SDK is not installed', async () => {
    const stop = await startTracing(true, () => Promise.reject(new Error('Cannot find module')));
    await expect(stop()).resolves.toBeUndefined();
  });
});
