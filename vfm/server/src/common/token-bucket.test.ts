import { describe, expect, it } from 'vitest';

import { TokenBucket } from './token-bucket';

describe('TokenBucket', () => {
  it('allows a burst, then refuses, then refills at the rate and never past the burst', () => {
    let t = 0;
    const bucket = new TokenBucket(10, 5, () => t);
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    t += 200; // 10/s for 0.2 s: two tokens
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    t += 60_000; // an idle minute does not bank more than the burst
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('holds a steady sender at exactly the rate', () => {
    let t = 0;
    const bucket = new TokenBucket(10, 1, () => t);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
      t += 10; // 100 attempts a second for 10 s
      if (bucket.take()) allowed += 1;
    }
    expect(allowed).toBeGreaterThanOrEqual(99);
    expect(allowed).toBeLessThanOrEqual(102);
  });
});
