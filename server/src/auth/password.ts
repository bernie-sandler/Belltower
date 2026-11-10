import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { AppError } from '../errors';

// scrypt N=2^16, r=8, p=1: ~64 MiB and ~200 ms per hash. Stored as
// scrypt$<log2 N>$<r>$<p>$<salt b64>$<key b64> so parameters can be raised later (rehash on login).
const DEFAULT_LOG_N = 16;
const R = 8;
const P = 1;
const KEY_LEN = 32;

let logN = DEFAULT_LOG_N;

/** Tests use a cheap cost so the suite stays fast. */
export function setScryptCostForTests(newLogN: number): void {
  logN = newLogN;
}

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function opts(n: number, r: number, p: number): ScryptOptions {
  // maxmem must exceed 128 * N * r; leave headroom.
  return { N: 2 ** n, r, p, maxmem: 2 * 128 * 2 ** n * r };
}

// Hashing is deliberately expensive, so run at most one at a time with a short queue. A burst of
// login attempts gets 429 instead of eating memory on a box that also runs Plex and VMs.
const MAX_QUEUE = 5;
let running = false;
const waiters: (() => void)[] = [];

async function singleFlight<T>(fn: () => Promise<T>): Promise<T> {
  if (running) {
    if (waiters.length >= MAX_QUEUE) throw new AppError(429, 'busy', 'Too many password checks in progress; try again');
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    running = true;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else running = false;
  }
}

const normalize = (pw: string) => pw.normalize('NFKC');

export function hashPassword(password: string): Promise<string> {
  return singleFlight(async () => {
    const salt = randomBytes(16);
    const key = await scryptAsync(normalize(password), salt, KEY_LEN, opts(logN, R, P));
    return ['scrypt', logN, R, P, salt.toString('base64'), key.toString('base64')].join('$');
  });
}

interface Parsed {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 22) return null;
  return { logN: n, r, p, salt: Buffer.from(parts[4]!, 'base64'), key: Buffer.from(parts[5]!, 'base64') };
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return Promise.resolve(false);
  return singleFlight(async () => {
    const key = await scryptAsync(normalize(password), parsed.salt, parsed.key.length, opts(parsed.logN, parsed.r, parsed.p));
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  });
}

/**
 * Does the same work as checking a real password, and always fails. Login runs it for unknown,
 * deactivated and single-sign-on-only accounts, so the answer time doesn't tell which usernames exist.
 */
export function verifyDummy(password: string): Promise<false> {
  const fake = ['scrypt', logN, R, P, randomBytes(16).toString('base64'), randomBytes(KEY_LEN).toString('base64')].join('$');
  return verifyPassword(password, fake).then(() => false);
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.logN !== logN || parsed.r !== R || parsed.p !== P;
}

// ---- first-run setup code ----

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

/** 20 characters from a 31-symbol alphabet (~99 bits), shown as XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateSetupCode(): string {
  const bytes = randomBytes(40);
  let out = '';
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 31 * 8, keeps the distribution uniform
    out += CODE_ALPHABET[b % 31];
    if (out.length === 20) break;
  }
  if (out.length < 20) return generateSetupCode();
  return out.match(/.{5}/g)!.join('-');
}

export function setupCodeMatches(input: string, code: string): boolean {
  const clean = (s: string) => Buffer.from(s.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const a = clean(input);
  const b = clean(code);
  return a.length === b.length && timingSafeEqual(a, b);
}
