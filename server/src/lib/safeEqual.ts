import { timingSafeEqual } from 'node:crypto';

/** Compares two secrets in constant time (only a difference in length returns early). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
