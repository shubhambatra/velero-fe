/**
 * A token bucket: `burst` tokens to start with, `perSecond` more each second up to `burst`.
 * `take()` spends one and says whether there was one to spend. The clock is injectable so the
 * tests do not wait.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    // Not `< 1`: ten additions of 0.1 are 0.9999999999999999, which would refuse a sender at exactly the rate.
    if (this.tokens < 1 - 1e-9) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
