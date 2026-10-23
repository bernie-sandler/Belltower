import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT, LoginRateLimiter, clientKey } from '../src/auth/rateLimit';
import { fixedClock } from '../src/clock';

describe('clientKey', () => {
  it('groups IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
    expect(clientKey('192.168.1.5')).toBe('192.168.1.5');
    expect(clientKey('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64');
  });
});

describe('LoginRateLimiter', () => {
  it('paces attempts globally after many failures instead of letting them run together', () => {
    const clock = fixedClock('2026-10-10T15:00:00.000Z');
    const limiter = new LoginRateLimiter(clock, {
      ...DEFAULT_RATE_LIMIT,
      globalPerHour: 3,
      globalDelayMs: 1000,
      maxQueueDelayMs: 3500,
    });
    for (let i = 0; i < 3; i++) limiter.recordFailure(`10.0.0.${i}`);
    expect([1, 2, 3].map((i) => limiter.check(`10.1.0.${i}`))).toEqual([
      { allowed: true, delayMs: 1000 },
      { allowed: true, delayMs: 2000 },
      { allowed: true, delayMs: 3000 },
    ]);
    expect(limiter.check('10.1.0.9')).toEqual({ allowed: false, retryAfterSec: 4 });
    clock.advance(3_600_001);
    expect(limiter.check('10.1.0.9')).toEqual({ allowed: true, delayMs: 0 });
  });

  it('locks one client after 5 failures within the window and forgets after success', () => {
    const clock = fixedClock('2026-10-10T15:00:00.000Z');
    const limiter = new LoginRateLimiter(clock, { ...DEFAULT_RATE_LIMIT, globalDelayMs: 0 });
    for (let i = 0; i < 4; i++) limiter.recordFailure('10.0.0.1');
    limiter.recordSuccess('10.0.0.1');
    for (let i = 0; i < 4; i++) limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toEqual({ allowed: false, retryAfterSec: 900 });
  });
});
