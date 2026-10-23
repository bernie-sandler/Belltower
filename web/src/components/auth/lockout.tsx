// 429 rate_limited handling shared by login, first-run setup and change password: the server
// says how long this device is locked out (retryAfterSec); we count down and keep submit disabled.

import { useCallback, useEffect, useState } from 'react';

export function formatWait(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Plain words for screen readers (announced once, not every second). */
function spokenWait(sec: number): string {
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const m = Math.ceil(sec / 60);
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}

export interface Lockout {
  locked: boolean;
  secondsLeft: number;
  /** Length of the current lockout when it started (for the spoken message). */
  totalSec: number;
  lock: (sec: number) => void;
}

export function useLockout(): Lockout {
  const [until, setUntil] = useState<number | null>(null);
  const [totalSec, setTotalSec] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return undefined;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) setUntil(null);
    }, 1000);
    return () => window.clearInterval(t);
  }, [until]);

  const lock = useCallback((sec: number) => {
    const n = Date.now();
    setNow(n);
    setTotalSec(sec);
    setUntil(n + sec * 1000);
  }, []);

  const secondsLeft = until !== null ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return { locked: secondsLeft > 0, secondsLeft, totalSec, lock };
}

/** "Too many failed attempts. Try again in 14:32." — the ticking part is hidden from screen readers. */
export function LockoutMessage({ lockout }: { lockout: Lockout }) {
  if (!lockout.locked) return null;
  return (
    <p className="form-error lockout" role="alert">
      Too many failed attempts.{' '}
      <span aria-hidden="true">
        Try again in <span className="lockout-time">{formatWait(lockout.secondsLeft)}</span>.
      </span>
      <span className="visually-hidden">Try again in {spokenWait(lockout.totalSec)}.</span>
    </p>
  );
}
