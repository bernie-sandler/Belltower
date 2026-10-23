/** Injectable time source so services, sessions and the scheduler can be tested deterministically. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TestClock extends Clock {
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function fixedClock(start: Date | string): TestClock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (at) => {
      t = new Date(at).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
