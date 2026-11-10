import { CSRF_VALUE } from '@tt/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { bootstrapAuth } from '../src/auth/bootstrap';
import { setScryptCostForTests } from '../src/auth/password';
import { DEFAULT_RATE_LIMIT, LoginRateLimiter } from '../src/auth/rateLimit';
import { fixedClock } from '../src/clock';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { seedDefaults } from '../src/db/seed';
import { createLogger } from '../src/logger';
import type { TicketDrafter } from '../src/services/aiDraft';
import type { Notifier } from '../src/services/notify';
import type { Ctx } from '../src/services/context';

setScryptCostForTests(10);

/** Saturday 2026-10-10 10:00 in Chicago. */
export const T0 = '2026-10-10T15:00:00.000Z';
export const PASSWORD = 'correct horse battery staple';

export function makeCtx(opts: { now?: string; tz?: string; seed?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tt-test-'));
  const db = openDatabase(path.join(dir, 'tower.db'));
  migrate(db);
  const clock = fixedClock(opts.now ?? T0);
  const ctx: Ctx = { db, clock, tz: opts.tz ?? 'America/Chicago' };
  if (opts.seed !== false) seedDefaults(ctx);
  return {
    ctx,
    clock,
    dir,
    close() {
      // A restore swaps ctx.db for a new connection; close whichever is current.
      if (ctx.db.open) ctx.db.close();
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function columnId(ctx: Ctx, name: string): number {
  return ctx.db.prepare('SELECT id FROM columns WHERE name = ?').pluck().get(name) as number;
}

export function labelId(ctx: Ctx, name: string): number {
  return ctx.db.prepare('SELECT id FROM labels WHERE name = ?').pluck().get(name) as number;
}

export interface TestApp extends ReturnType<typeof makeCtx> {
  app: FastifyInstance;
  logLines: string[];
  auth: Awaited<ReturnType<typeof bootstrapAuth>>;
  shutdown(): Promise<void>;
}

export async function makeApp(
  opts: { env?: Record<string, string>; webDist?: boolean; globalDelayMs?: number; ai?: TicketDrafter; notifier?: Notifier } = {},
): Promise<TestApp> {
  const t = makeCtx();
  let webDistDir: string | null = null;
  if (opts.webDist) {
    webDistDir = path.join(t.dir, 'web');
    mkdirSync(path.join(webDistDir, 'assets'), { recursive: true });
    writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>Belltower</title>');
    writeFileSync(path.join(webDistDir, 'assets', 'index-abc123.js'), 'console.log("hi")');
  }
  const config = {
    ...loadConfig({ DATA_DIR: t.dir, TZ: 'America/Chicago', ...opts.env }),
    webDistDir,
  };
  const logLines: string[] = [];
  const log = createLogger({ level: 'info', write: (l) => logLines.push(l) });
  const auth = await bootstrapAuth(t.ctx, config.appPassword, log);
  const limiter = new LoginRateLimiter(t.clock, { ...DEFAULT_RATE_LIMIT, globalDelayMs: opts.globalDelayMs ?? 0 });
  const app = await buildApp({ baseCtx: t.ctx, config, auth, limiter, ai: opts.ai ?? null, notifier: opts.notifier }, log);
  await app.ready();
  return {
    ...t,
    app,
    logLines,
    auth,
    async shutdown() {
      await app.close();
      t.close();
    },
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A tiny client that sends the CSRF header and a session cookie like the SPA does. */
export function client(app: FastifyInstance, cookie?: string) {
  return (method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: {
        ...(method === 'GET' ? {} : { 'x-requested-with': CSRF_VALUE }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'tt_sid');
  if (!c) throw new Error(`no session cookie in response (status ${res.statusCode}: ${res.body})`);
  return `tt_sid=${c.value}`;
}

/** Completes first-run setup with the logged code (the owner is `admin`) and returns the session cookie. */
export async function setupAndLogin(t: TestApp): Promise<string> {
  const res = await client(t.app)('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, password: PASSWORD });
  if (res.statusCode !== 204) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

/** Signs in as someone and returns the session cookie (throws on failure). Each call uses its own address, so the limiter stays out of it. */
let loginCounter = 0;
export async function loginAs(t: TestApp, username: string, password = PASSWORD): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: `10.77.${Math.floor(++loginCounter / 250)}.${loginCounter % 250}`,
    headers: { 'x-requested-with': CSRF_VALUE },
    payload: { username, password },
  });
  return sessionCookie(res);
}

/** An admin adds someone (with PASSWORD unless given) and that person signs in. Returns their id and cookie. */
export async function addPerson(
  t: TestApp,
  adminCookie: string,
  username: string,
  role: 'admin' | 'member' = 'member',
  password = PASSWORD,
): Promise<{ id: number; cookie: string }> {
  const res = await client(t.app, adminCookie)('POST', '/api/users', { username, displayName: username, role, password });
  if (res.statusCode !== 201) throw new Error(`adding ${username} failed: ${res.statusCode} ${res.body}`);
  return { id: res.json().id as number, cookie: await loginAs(t, username, password) };
}
