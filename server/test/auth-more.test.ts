import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAuth } from '../src/auth/bootstrap';
import { lookupSession } from '../src/auth/sessions';
import { openDatabase } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { seedDefaults } from '../src/db/seed';
import { createLogger } from '../src/logger';
import { listActivity } from '../src/services/activity';
import { PASSWORD, client, makeApp, sessionCookie, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

describe('auth races and limits', () => {
  it('a login racing a password change never yields a session that survives the change', async () => {
    t = await makeApp();
    const app = t.app;
    const mine = await setupAndLogin(t);
    let pw = PASSWORD;
    for (let i = 0; i < 5; i++) {
      const next = `rotated password number ${i}`;
      const [login, change] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: `10.0.0.${i + 1}`,
          headers: { 'x-requested-with': 'tower-tracker' },
          payload: { password: pw, remember: true },
        }),
        client(app, mine)('POST', '/api/auth/password', { currentPassword: pw, newPassword: next }),
      ]);
      expect(change.statusCode).toBe(204);
      if (login.statusCode === 204) {
        expect((await client(app, sessionCookie(login))('GET', '/api/board')).statusCode).toBe(401);
      } else {
        expect(login.statusCode).toBe(401);
      }
      pw = next;
    }
  });

  it('only one of two concurrent setup requests wins', async () => {
    t = await makeApp();
    const api = client(t.app);
    const results = await Promise.all([
      api('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, password: PASSWORD }),
      api('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, password: 'a different password' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 404]);
  });

  it('locks out a whole IPv6 /64, not just one address', async () => {
    t = await makeApp({ env: { TRUST_PROXY: '127.0.0.1' } });
    const app = t.app;
    await setupAndLogin(t);
    const attempt = (xff: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-requested-with': 'tower-tracker', 'x-forwarded-for': xff },
        payload: { password },
      });
    for (let i = 1; i <= 5; i++) expect((await attempt(`2001:db8:1:2::${i}`, 'wrong')).statusCode).toBe(401);
    expect((await attempt('2001:db8:1:2:ffff::99', PASSWORD)).statusCode).toBe(429);
    expect((await attempt('2001:db8:1:3::1', PASSWORD)).statusCode).toBe(204);
  });
});

describe('restarts', () => {
  it('keeps data, history and sessions across a restart; rotating APP_PASSWORD signs everyone out', async () => {
    t = await makeApp();
    const cookie = await setupAndLogin(t);
    const card = (await client(t.app, cookie)('POST', '/api/cards', { title: 'Survives restarts' })).json();
    await t.app.close();
    t.ctx.db.close();

    const log = createLogger({ level: 'silent' });
    const db = openDatabase(path.join(t.dir, 'tower.db'));
    const ctx = { db, clock: t.clock, tz: 'America/Chicago' };
    try {
      expect(migrate(db)).toEqual([]);
      expect(seedDefaults(ctx)).toBe(false);
      expect(await bootstrapAuth(ctx, null, log)).toEqual({ setupCode: null, passwordSource: 'ui' });
      const token = cookie.slice('tt_sid='.length);
      expect(lookupSession(ctx, { rememberDays: 90 }, token)).not.toBeNull();
      expect(listActivity(ctx, card.id).map((e) => e.type)).toEqual(['created']);

      expect((await bootstrapAuth(ctx, 'now from the environment', log)).passwordSource).toBe('env');
      expect(lookupSession(ctx, { rememberDays: 90 }, token)).toBeNull();
      expect((await bootstrapAuth(ctx, null, log)).passwordSource).toBe('ui');
    } finally {
      db.close();
      t.close();
      t = undefined;
    }
  });
});
