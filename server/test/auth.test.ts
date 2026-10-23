import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, client, makeApp, sessionCookie, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

describe('first-run setup', () => {
  it('prints a setup code and requires it', async () => {
    t = await makeApp();
    expect(t.auth.setupCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(t.logLines.join('\n')).toContain(t.auth.setupCode!);

    const api = client(t.app);
    expect((await api('GET', '/api/auth/status')).json()).toEqual({
      authenticated: false,
      setupRequired: true,
      passwordManagedByEnv: false,
    });

    const wrong = await api('POST', '/api/auth/setup', { setupCode: 'AAAAA-AAAAA-AAAAA-AAAAA', password: PASSWORD });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe('invalid_setup_code');

    const short = await api('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, password: 'short' });
    expect(short.statusCode).toBe(400);

    // Lower-case and without dashes is accepted.
    const code = t.auth.setupCode!.replaceAll('-', '').toLowerCase();
    const ok = await api('POST', '/api/auth/setup', { setupCode: code, password: PASSWORD });
    expect(ok.statusCode).toBe(204);
    const cookie = sessionCookie(ok);
    expect((await client(t.app, cookie)('GET', '/api/auth/status')).json()).toMatchObject({
      authenticated: true,
      setupRequired: false,
    });

    const again = await api('POST', '/api/auth/setup', { setupCode: code, password: PASSWORD });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('setup_not_available');
  });

  it('refuses login before setup', async () => {
    t = await makeApp();
    const res = await client(t.app)('POST', '/api/auth/login', { password: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('setup_required');
  });
});

describe('login and sessions', () => {
  it('logs in, protects the API, and logs out', async () => {
    t = await makeApp();
    await setupAndLogin(t);
    const anon = client(t.app);
    expect((await anon('GET', '/api/board')).statusCode).toBe(401);
    expect((await anon('GET', '/api/board')).json().error).toBe('unauthenticated');

    const bad = await anon('POST', '/api/auth/login', { password: 'nope' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_password');

    const ok = await anon('POST', '/api/auth/login', { password: PASSWORD, remember: false });
    expect(ok.statusCode).toBe(204);
    const cookie = ok.cookies.find((c) => c.name === 'tt_sid')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.expires).toBeUndefined(); // browser-session cookie without "remember"
    expect(cookie.secure).toBeFalsy(); // plain HTTP

    const api = client(t.app, sessionCookie(ok));
    expect((await api('GET', '/api/board')).statusCode).toBe(200);
    expect((await api('POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await api('GET', '/api/board')).statusCode).toBe(401);
  });

  it('expires a non-remembered session after 12h idle but keeps a remembered one', async () => {
    t = await makeApp();
    await setupAndLogin(t);
    const anon = client(t.app);
    const short = sessionCookie(await anon('POST', '/api/auth/login', { password: PASSWORD, remember: false }));
    const long = await anon('POST', '/api/auth/login', { password: PASSWORD, remember: true });
    const longCookie = long.cookies.find((c) => c.name === 'tt_sid')!;
    expect(new Date(longCookie.expires!).getTime() - t.clock.now().getTime()).toBe(90 * 86_400_000);

    t.clock.advance(11 * 3_600_000);
    expect((await client(t.app, short)('GET', '/api/board')).statusCode).toBe(200); // slides the idle timer
    t.clock.advance(11 * 3_600_000);
    expect((await client(t.app, short)('GET', '/api/board')).statusCode).toBe(200);
    t.clock.advance(13 * 3_600_000);
    expect((await client(t.app, short)('GET', '/api/board')).statusCode).toBe(401);

    const res = await client(t.app, sessionCookie(long))('GET', '/api/board');
    expect(res.statusCode).toBe(200);
    // A remembered session that slid gets a refreshed cookie.
    expect(res.cookies.find((c) => c.name === 'tt_sid')).toBeDefined();
  });

  it('marks the cookie Secure when reached over HTTPS through a trusted proxy only', async () => {
    t = await makeApp({ env: { TRUST_PROXY: '127.0.0.1' } });
    await setupAndLogin(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-requested-with': 'tower-tracker', 'x-forwarded-proto': 'https' },
      payload: { password: PASSWORD },
    });
    expect(res.cookies.find((c) => c.name === 'tt_sid')!.secure).toBe(true);

    const spoofed = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.9.9.9',
      headers: { 'x-requested-with': 'tower-tracker', 'x-forwarded-proto': 'https' },
      payload: { password: PASSWORD },
    });
    expect(spoofed.cookies.find((c) => c.name === 'tt_sid')!.secure).toBeFalsy();
  });
});

describe('rate limiting', () => {
  it('locks an IP out after 5 failures, before checking the password', async () => {
    t = await makeApp();
    await setupAndLogin(t);
    const anon = client(t.app);
    for (let i = 0; i < 5; i++) {
      expect((await anon('POST', '/api/auth/login', { password: 'wrong' })).statusCode).toBe(401);
    }
    const locked = await anon('POST', '/api/auth/login', { password: PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: 'rate_limited', retryAfterSec: 900 });
    expect(locked.headers['retry-after']).toBe('900');

    // Another IP is unaffected (no global hard lockout).
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.50',
      headers: { 'x-requested-with': 'tower-tracker' },
      payload: { password: PASSWORD },
    });
    expect(other.statusCode).toBe(204);

    t.clock.advance(15 * 60_000);
    expect((await anon('POST', '/api/auth/login', { password: PASSWORD })).statusCode).toBe(204);
  });

  it('ignores a spoofed X-Forwarded-For unless the proxy is trusted', async () => {
    t = await makeApp();
    await setupAndLogin(t);
    for (let i = 0; i < 5; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-requested-with': 'tower-tracker', 'x-forwarded-for': `6.6.6.${i}` },
        payload: { password: 'wrong' },
      });
    }
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-requested-with': 'tower-tracker', 'x-forwarded-for': '7.7.7.7' },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe('password management', () => {
  it('changes the password and signs out other devices', async () => {
    t = await makeApp();
    const mine = await setupAndLogin(t);
    const other = sessionCookie(await client(t.app)('POST', '/api/auth/login', { password: PASSWORD }));
    const api = client(t.app, mine);

    const wrong = await api('POST', '/api/auth/password', { currentPassword: 'nope', newPassword: 'another long password' });
    expect(wrong.statusCode).toBe(401);

    const ok = await api('POST', '/api/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'another long password',
    });
    expect(ok.statusCode).toBe(204);
    expect((await api('GET', '/api/board')).statusCode).toBe(200);
    expect((await client(t.app, other)('GET', '/api/board')).statusCode).toBe(401);
    expect((await client(t.app)('POST', '/api/auth/login', { password: 'another long password' })).statusCode).toBe(204);
  });

  it('uses APP_PASSWORD when set and disables changing it in the app', async () => {
    t = await makeApp({ env: { APP_PASSWORD: 'from the environment' } });
    expect(t.auth).toEqual({ setupCode: null, passwordSource: 'env' });
    const anon = client(t.app);
    expect((await anon('GET', '/api/auth/status')).json()).toEqual({
      authenticated: false,
      setupRequired: false,
      passwordManagedByEnv: true,
    });
    const login = await anon('POST', '/api/auth/login', { password: 'from the environment' });
    expect(login.statusCode).toBe(204);
    const res = await client(t.app, sessionCookie(login))('POST', '/api/auth/password', {
      currentPassword: 'from the environment',
      newPassword: 'something else entirely',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('managed_by_env');
  });
});
