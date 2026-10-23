import { isIPv6 } from 'node:net';
import type { Clock } from '../clock';

export interface RateLimitOptions {
  /** Failures from one client within `windowMs` before that client is locked out. */
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  /** Across all clients: after this many failures in an hour, attempts are paced (never blocked). */
  globalPerHour: number;
  /** Minimum spacing between attempts while paced. */
  globalDelayMs: number;
  /** While paced, attempts that would wait longer than this are turned away with a retry time. */
  maxQueueDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  globalPerHour: 30,
  globalDelayMs: 3_000,
  maxQueueDelayMs: 30_000,
};

export type RateLimitDecision = { allowed: true; delayMs: number } | { allowed: false; retryAfterSec: number };

/** Expands an IPv6 address to 8 groups of 4 hex digits. */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * The identity a lockout applies to. IPv4-mapped IPv6 becomes plain IPv4; other IPv6 addresses are
 * grouped by /64, since a single client can rotate through its whole /64 at will.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const bare = ip.split('%', 1)[0]!;
  if (isIPv6(bare)) return `${expandIPv6(bare).slice(0, 4).join(':')}::/64`;
  return ip;
}

/**
 * Failed-login limiter. A per-client lockout stops guessing from one address; the global limit
 * only paces attempts, so an attacker hammering through the reverse proxy can't lock the owner out
 * on the LAN. In memory on purpose: a restart resets it, which is fine for a single-user app.
 */
export class LoginRateLimiter {
  private perClient = new Map<string, { failures: number[]; lockedUntil: number }>();
  private globalFailures: number[] = [];
  private nextGlobalSlot = 0;

  constructor(
    private readonly clock: Clock,
    private readonly opts: RateLimitOptions = DEFAULT_RATE_LIMIT,
  ) {}

  check(ip: string): RateLimitDecision {
    const now = this.clock.now().getTime();
    const entry = this.perClient.get(clientKey(ip));
    if (entry && entry.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    this.globalFailures = this.globalFailures.filter((t) => now - t < 3_600_000);
    if (this.globalFailures.length < this.opts.globalPerHour || this.opts.globalDelayMs <= 0) {
      return { allowed: true, delayMs: 0 };
    }
    // Paced mode: hand out one slot per globalDelayMs, so concurrent attempts queue up instead of
    // all sleeping the same amount and running together.
    const slot = Math.max(now, this.nextGlobalSlot) + this.opts.globalDelayMs;
    const delayMs = slot - now;
    if (delayMs > this.opts.maxQueueDelayMs) {
      return { allowed: false, retryAfterSec: Math.ceil(delayMs / 1000) };
    }
    this.nextGlobalSlot = slot;
    return { allowed: true, delayMs };
  }

  recordFailure(ip: string): void {
    const now = this.clock.now().getTime();
    const key = clientKey(ip);
    this.globalFailures.push(now);
    const entry = this.perClient.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.opts.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.opts.maxFailures) {
      entry.lockedUntil = now + this.opts.lockMs;
      entry.failures = [];
    }
    this.perClient.set(key, entry);
  }

  recordSuccess(ip: string): void {
    this.perClient.delete(clientKey(ip));
  }

  /** Drops stale entries so the map can't grow without bound. */
  prune(): void {
    const now = this.clock.now().getTime();
    for (const [key, e] of this.perClient) {
      if (e.lockedUntil <= now && e.failures.every((t) => now - t >= this.opts.windowMs)) this.perClient.delete(key);
    }
    this.globalFailures = this.globalFailures.filter((t) => now - t < 3_600_000);
  }
}
