// A simple sliding-window limit: at most `max` hits per key within `windowMs`. In memory only, so
// it resets when the container restarts (fine for spam and runaway-script protection).

import type { Clock } from '../clock';

export class WindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a hit unless the key is over its limit; then says how long to wait. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.clock.now().getTime();
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(now);
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [k, list] of this.hits) if (!list.some((t) => t > now - this.windowMs)) this.hits.delete(k);
  }
}
