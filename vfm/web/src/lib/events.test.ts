import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openStream } from './events';

/** A scriptable stand-in for the browser's EventSource. */
class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, handler: () => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string): void {
    for (const h of this.handlers.get(type) ?? []) {
      h();
    }
  }
}

const create = (url: string): EventSource => new FakeSource(url) as unknown as EventSource;

describe('the live-update stream', () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
    client = new QueryClient();
    invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the organization stream with credentials', () => {
    const stop = openStream('o1', client, { createSource: create });
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]?.url).toBe('/api/v1/stream');
    stop();
  });

  it('turns a burst of events into one refresh, of fleet and cluster queries in this org only', () => {
    const stop = openStream('o1', client, { createSource: create });
    const source = FakeSource.all[0] as FakeSource;
    source.emit('cluster');
    source.emit('inventory');
    source.emit('command');
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(invalidate).toHaveBeenCalledTimes(1);

    const arg = invalidate.mock.calls[0]?.[0] as {
      predicate: (q: { queryKey: unknown[] }) => boolean;
    };
    expect(arg.predicate({ queryKey: ['org', 'o1', 'fleet'] })).toBe(true);
    expect(arg.predicate({ queryKey: ['org', 'o1', 'clusters'] })).toBe(true);
    expect(arg.predicate({ queryKey: ['org', 'o1', 'cluster', 'c1', 'overview'] })).toBe(true);
    // Not another organization's data, and not unrelated pages.
    expect(arg.predicate({ queryKey: ['org', 'o2', 'fleet'] })).toBe(false);
    expect(arg.predicate({ queryKey: ['org', 'o1', 'tokens'] })).toBe(false);
    expect(arg.predicate({ queryKey: ['session'] })).toBe(false);
    stop();
  });

  it('re-reads on connect, because anything that changed while it was down is found only by looking', () => {
    const stop = openStream('o1', client, { createSource: create });
    (FakeSource.all[0] as FakeSource).emit('open');
    vi.advanceTimersByTime(400);
    expect(invalidate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reconnects by hand, with growing delays, after the browser gives up', () => {
    const stop = openStream('o1', client, { createSource: create, backoffStartMs: 1_000 });
    const first = FakeSource.all[0] as FakeSource;
    first.readyState = 2;
    first.emit('error');
    expect(first.closed).toBe(true);
    expect(FakeSource.all).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(FakeSource.all).toHaveLength(2);

    const second = FakeSource.all[1] as FakeSource;
    second.readyState = 2;
    second.emit('error');
    vi.advanceTimersByTime(1_000);
    expect(FakeSource.all).toHaveLength(2); // the second wait is longer
    vi.advanceTimersByTime(1_000);
    expect(FakeSource.all).toHaveLength(3);
    stop();
  });

  it('leaves a stream the browser is retrying itself alone', () => {
    const stop = openStream('o1', client, { createSource: create });
    const source = FakeSource.all[0] as FakeSource;
    source.readyState = 0; // CONNECTING: the browser is on it
    source.emit('error');
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
    expect(source.closed).toBe(false);
    stop();
  });

  it('resets the backoff once it has been connected', () => {
    const stop = openStream('o1', client, { createSource: create, backoffStartMs: 1_000 });
    const first = FakeSource.all[0] as FakeSource;
    first.readyState = 2;
    first.emit('error');
    vi.advanceTimersByTime(1_000);
    const second = FakeSource.all[1] as FakeSource;
    second.emit('open');
    second.readyState = 2;
    second.emit('error');
    vi.advanceTimersByTime(1_000);
    expect(FakeSource.all).toHaveLength(3); // back to the short delay
    stop();
  });

  it('stops everything when closed: no further connection, no pending refresh', () => {
    const stop = openStream('o1', client, { createSource: create, backoffStartMs: 1_000 });
    const source = FakeSource.all[0] as FakeSource;
    source.emit('cluster');
    source.readyState = 2;
    source.emit('error');
    stop();

    vi.advanceTimersByTime(120_000);
    expect(source.closed).toBe(true);
    expect(FakeSource.all).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does nothing quietly where the browser has no EventSource', () => {
    const stop = openStream('o1', client);
    expect(FakeSource.all).toHaveLength(0);
    stop();
  });
});
