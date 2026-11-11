// Single sign-on (OIDC) against a mock provider: a plain-HTTP server in this file with its own RS256
// keys (jose), so the tests turn on "Allow a plain-HTTP issuer". The browser's trip through the
// provider's login page is simulated: the test reads the authorize address /start redirects to and
// builds the callback the provider would send back.

import { CSRF_VALUE, DEFAULT_TICKET_FORMAT } from '@tt/shared';
import type { LightMyRequestResponse } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { withGroupsScope } from '../src/auth/oidc';
import { describeGroupMiss, type OidcSettings } from '../src/services/oidc';
import { PASSWORD, addPerson, client, loginAs, makeApp, setupAndLogin, type TestApp } from './helpers';

const APP_HOST = 'belltower.test';
const APP_URL = `http://${APP_HOST}`;
const CLIENT_ID = 'belltower';
const CLIENT_SECRET = 'mock-client-secret-0123456789';

interface IdpUser {
  sub: string;
  /** Claims in the ID token (besides iss, sub, aud, nonce and the times). */
  id?: Record<string, unknown>;
  /** Claims only the userinfo endpoint sends (Authelia keeps email and groups there). */
  userinfo?: Record<string, unknown>;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

class MockIdp {
  readonly codes = new Map<string, { user: IdpUser; nonce: string; challenge: string; redirectUri: string; scope: string }>();
  readonly tokens = new Map<string, IdpUser>();
  discoveryHits = 0;
  /** Seconds the provider's clock is ahead (+) or behind (−). */
  clockOffsetSec = 0;
  /** Discovery answers 500 while set. */
  failDiscovery = false;
  clientSecret = CLIENT_SECRET;
  /**
   * How ID tokens are signed: with the published key; with another RSA key under the same kid (a
   * forged or tampered token); or HS256 with the client secret (Authentik without a signing key).
   */
  signing: 'good' | 'wrong-key' | 'hs256' = 'good';
  /** What discovery lists in id_token_signing_alg_values_supported. */
  algs = ['RS256'];
  /** What discovery lists in scopes_supported; null leaves it out. */
  scopesSupported: string[] | null = null;
  /** VoidAuth's way: the groups claim is sent only when the `groups` scope was asked for. */
  groupsNeedScope = false;
  /** The scope of the last authorize request. */
  lastScope: string | null = null;

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    readonly issuer: string,
    private readonly key: CryptoKey,
    private readonly otherKey: CryptoKey,
    private readonly jwk: Record<string, unknown>,
  ) {}

  /** `issuerPath` '/application/o/belltower/' is Authentik's shape; '' is Authelia's (just the origin). */
  static async start(issuerPath = '/application/o/belltower/'): Promise<MockIdp> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const idp = new MockIdp(server, origin, `${origin}${issuerPath}`, privateKey, other.privateKey, jwk);
    server.on('request', (req, res) => {
      idp.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(body));
        },
        (err: Error) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error', error_description: err.message }));
        },
      );
    });
    return idp;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', this.origin);
    const discovery = new URL(`${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`).pathname;
    if (req.method === 'GET' && url.pathname === discovery) {
      this.discoveryHits++;
      if (this.failDiscovery) return { status: 500, body: { error: 'down' } };
      return {
        status: 200,
        body: {
          issuer: this.issuer,
          authorization_endpoint: `${this.origin}/authorize`,
          token_endpoint: `${this.origin}/token`,
          userinfo_endpoint: `${this.origin}/userinfo`,
          jwks_uri: `${this.origin}/jwks`,
          response_types_supported: ['code'],
          response_modes_supported: ['query'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: this.algs,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          ...(this.scopesSupported ? { scopes_supported: this.scopesSupported } : {}),
        },
      };
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return { status: 200, body: { keys: [this.jwk] } };
    if (req.method === 'POST' && url.pathname === '/token') return this.token(req);
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const user = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return { status: 401, body: { error: 'invalid_token' } };
      return { status: 200, body: { sub: user.sub, ...user.id, ...user.userinfo } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  private async token(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const [id, secret] = basic.split(':').map((p) => decodeURIComponent(p.replace(/\+/g, ' ')));
    if (id !== CLIENT_ID || secret !== this.clientSecret) return { status: 401, body: { error: 'invalid_client' } };
    const entry = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    if (!entry || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== entry.redirectUri) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    if (b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== entry.challenge) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE' } };
    }
    const user = this.visible(entry.user, entry.scope);
    const now = Math.floor(Date.now() / 1000) + this.clockOffsetSec;
    const jwt = new SignJWT({ nonce: entry.nonce, ...user.id })
      .setProtectedHeader(this.signing === 'hs256' ? { alg: 'HS256' } : { alg: 'RS256', kid: 'k1' })
      .setIssuer(this.issuer)
      .setSubject(user.sub)
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 60);
    const idToken =
      this.signing === 'hs256'
        ? await jwt.sign(new TextEncoder().encode(this.clientSecret))
        : await jwt.sign(this.signing === 'wrong-key' ? this.otherKey : this.key);
    const accessToken = b64url(randomBytes(16));
    this.tokens.set(accessToken, user);
    return { status: 200, body: { access_token: accessToken, token_type: 'Bearer', expires_in: 60, id_token: idToken } };
  }

  /** The user's claims as this scope shows them: without `groups` unless asked for, when groupsNeedScope is on. */
  private visible(user: IdpUser, scope: string): IdpUser {
    if (!this.groupsNeedScope || scope.split(' ').includes('groups')) return user;
    const drop = (claims?: Record<string, unknown>) => (claims ? Object.fromEntries(Object.entries(claims).filter(([k]) => k !== 'groups')) : claims);
    return { ...user, id: drop(user.id), userinfo: drop(user.userinfo) };
  }

  /** The provider's login page: checks the request and returns the callback address with a fresh code. */
  authorize(location: string, user: IdpUser): string {
    const u = new URL(location);
    expect(u.origin + u.pathname).toBe(`${this.origin}/authorize`);
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('response_mode')).toBe('query');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')?.split(' ')).toContain('openid');
    expect(p.get('state')).toBeTruthy();
    expect(p.get('nonce')).toBeTruthy();
    const code = b64url(randomBytes(12));
    this.lastScope = p.get('scope');
    this.codes.set(code, { user, nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')!, scope: this.lastScope ?? '' });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    return back.href;
  }

  /** The provider sends someone back with an error instead (they pressed Deny). */
  deny(location: string): string {
    const p = new URL(location).searchParams;
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', p.get('state')!);
    return back.href;
  }
}

let apps: TestApp[] = [];
let idps: MockIdp[] = [];
afterEach(async () => {
  for (const a of apps) await a.shutdown();
  for (const i of idps) await i.close();
  apps = [];
  idps = [];
});

async function app(env?: Record<string, string>): Promise<{ t: TestApp; admin: string }> {
  const t = await makeApp(env ? { env } : {});
  apps.push(t);
  return { t, admin: await setupAndLogin(t) };
}

async function idp(issuerPath?: string): Promise<MockIdp> {
  const i = await MockIdp.start(issuerPath);
  idps.push(i);
  return i;
}

const settingsBody = (i: MockIdp, extra: Record<string, unknown> = {}) => ({
  enabled: true,
  preset: 'authentik',
  issuer: i.issuer,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allowHttpIssuer: true,
  ...extra,
});

/** Sets the app's address and turns single sign-on on against the mock provider. */
async function enableSso(t: TestApp, admin: string, i: MockIdp, extra: Record<string, unknown> = {}) {
  const api = client(t.app, admin);
  const general = await api('PUT', '/api/settings/general', { ticketFormat: DEFAULT_TICKET_FORMAT, appUrl: APP_URL, claudeModel: '' });
  expect(general.statusCode).toBe(200);
  const res = await api('PUT', '/api/settings/oidc', settingsBody(i, extra));
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** A request as the browser sends it to the app's own address. */
function browser(t: TestApp, url: string, cookies: string[] = [], extra: { method?: 'GET' | 'POST' | 'DELETE'; headers?: Record<string, string> } = {}) {
  const u = new URL(url, APP_URL);
  return t.app.inject({
    method: extra.method ?? 'GET',
    url: u.pathname + u.search,
    headers: { host: APP_HOST, ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...extra.headers },
  });
}

function cookieOf(res: LightMyRequestResponse, name: string): string | null {
  const c = res.cookies.find((x) => x.name === name && x.value !== '');
  return c ? `${name}=${c.value}` : null;
}

/** /start, then the provider's page. Returns the callback address and the flow cookie. */
async function startLogin(t: TestApp, i: MockIdp, user: IdpUser): Promise<{ callback: string; flow: string }> {
  const start = await browser(t, '/api/auth/oidc/start');
  expect(start.statusCode, start.body).toBe(302);
  const flow = cookieOf(start, 'tt_oidc');
  expect(flow).toBeTruthy();
  return { callback: i.authorize(start.headers.location as string, user), flow: flow! };
}

/** A whole sign-in. Returns the callback's redirect target and the session cookie, if one was set. */
async function ssoLogin(t: TestApp, i: MockIdp, user: IdpUser): Promise<{ location: string; session: string | null }> {
  const { callback, flow } = await startLogin(t, i, user);
  const res = await browser(t, callback, [flow]);
  expect(res.statusCode, res.body).toBe(302);
  return { location: res.headers.location as string, session: cookieOf(res, 'tt_sid') };
}

const alice: IdpUser = { sub: 'alice-sub', id: { preferred_username: 'Alice', name: 'Alice Liddell', email: 'alice@example.com', email_verified: true } };

describe('single sign-on settings', () => {
  it('stays off by default; status offers the button only when it is on and complete', async () => {
    const { t, admin } = await app();
    const i = await idp();
    const anon = client(t.app);
    expect((await anon('GET', '/api/auth/status')).json().sso).toBeNull();
    const info = (await client(t.app, admin)('GET', '/api/settings/oidc')).json();
    expect(info).toMatchObject({ enabled: false, preset: 'authentik', secretSet: false, ready: false, redirectUri: null, scopes: '' });

    // Needs the app's address first.
    const noUrl = await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i));
    expect(noUrl.statusCode).toBe(400);
    expect(noUrl.json().error).toBe('app_url_required');

    const saved = await enableSso(t, admin, i);
    expect(saved).toMatchObject({ enabled: true, ready: true, secretSet: true, secretFromEnv: false, redirectUri: `${APP_URL}/api/auth/oidc/callback` });
    expect((await anon('GET', '/api/auth/status')).json().sso).toEqual({ label: 'Authentik' });
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { buttonLabel: 'Homelab SSO', clientSecret: null }));
    expect((await anon('GET', '/api/auth/status')).json().sso).toEqual({ label: 'Homelab SSO' });

    // Clearing the app's address takes the button away again.
    await client(t.app, admin)('PUT', '/api/settings/general', { ticketFormat: DEFAULT_TICKET_FORMAT, appUrl: '', claudeModel: '' });
    expect((await anon('GET', '/api/auth/status')).json().sso).toBeNull();
    const start = await browser(t, '/api/auth/oidc/start');
    expect(start.headers.location).toBe('/login?sso_error=not_configured');
  });

  it('never sends the secret back; null keeps it, empty removes it, a new issuer host forgets it', async () => {
    const { t, admin } = await app();
    const i = await idp();
    const api = client(t.app, admin);
    await enableSso(t, admin, i);
    const got = await api('GET', '/api/settings/oidc');
    expect(got.body).not.toContain(CLIENT_SECRET);
    expect(got.json()).not.toHaveProperty('clientSecret');
    expect(got.json().secretSet).toBe(true);

    expect((await api('PUT', '/api/settings/oidc', settingsBody(i, { clientSecret: null }))).json().secretSet).toBe(true);
    const removed = await api('PUT', '/api/settings/oidc', settingsBody(i, { enabled: false, clientSecret: '' }));
    expect(removed.json().secretSet).toBe(false);
    // On without any secret: refused.
    const incomplete = await api('PUT', '/api/settings/oidc', settingsBody(i, { clientSecret: null }));
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error).toBe('sso_incomplete');

    await api('PUT', '/api/settings/oidc', settingsBody(i));
    const moved = await api('PUT', '/api/settings/oidc', settingsBody(i, { enabled: false, issuer: 'https://auth.elsewhere.example/application/o/x/', clientSecret: null }));
    expect(moved.json().secretSet).toBe(false);
  });

  it('refuses an http:// issuer unless plain HTTP is allowed', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const res = await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { allowHttpIssuer: false }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('insecure_issuer');
    const test = await client(t.app, admin)('POST', '/api/settings/oidc/test', { preset: 'custom', issuer: i.issuer });
    expect(test.statusCode).toBe(400);
    expect(test.json().error).toBe('insecure_issuer');
  });

  it('normalizes the issuer’s trailing slash per preset, and retries with it flipped', async () => {
    const { t, admin } = await app();
    const i = await idp('/application/o/belltower/');
    const bare = i.issuer.replace(/\/$/, '');
    // Authentik: the slash is added on save.
    expect((await enableSso(t, admin, i, { issuer: bare })).issuer).toBe(i.issuer);
    // Authelia: it's taken off.
    const authelia = await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { preset: 'authelia', clientSecret: null }));
    expect(authelia.json().issuer).toBe(bare);
    expect(authelia.json().scopes).toBe('');

    // Custom keeps it as typed; discovery tries the other spelling once, and sign-in works.
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { preset: 'custom', issuer: bare, autoCreate: true, clientSecret: null }));
    const login = await ssoLogin(t, i, alice);
    expect(login.location).toBe('/');
    expect(login.session).toBeTruthy();
    const linked = t.ctx.db.prepare('SELECT oidc_issuer FROM users WHERE oidc_subject = ?').pluck().get('alice-sub');
    expect(linked).toBe(i.issuer); // the provider's own spelling

    const test = await client(t.app, admin)('POST', '/api/settings/oidc/test', { preset: 'custom', issuer: bare, allowHttpIssuer: true });
    expect(test.json()).toMatchObject({ ok: true, issuer: i.issuer });
    expect(test.json().message).toContain('spelled');
  });

  it('Test connection explains what went wrong', async () => {
    const { t, admin } = await app();
    const i = await idp();
    const api = client(t.app, admin);
    const ok = await api('POST', '/api/settings/oidc/test', { preset: 'authentik', issuer: i.issuer, allowHttpIssuer: true });
    expect(ok.json()).toMatchObject({ ok: true, issuer: i.issuer });

    const wrong = await api('POST', '/api/settings/oidc/test', { preset: 'authentik', issuer: `${i.origin}/application/o/nope/`, allowHttpIssuer: true });
    expect(wrong.json()).toMatchObject({ ok: false, issuer: null });
    expect(wrong.json().message).toContain('HTTP 404');

    await i.close();
    idps = idps.filter((x) => x !== i);
    const down = await api('POST', '/api/settings/oidc/test', { preset: 'authentik', issuer: i.issuer, allowHttpIssuer: true });
    expect(down.json().ok).toBe(false);
    expect(down.json().message).toMatch(/Couldn’t reach 127\.0\.0\.1/);
  });

  it('uses OIDC_CLIENT_SECRET from the environment over a saved one', async () => {
    const { t, admin } = await app({ OIDC_CLIENT_SECRET: 'from-the-env-secret' });
    const i = await idp();
    i.clientSecret = 'from-the-env-secret';
    const saved = await enableSso(t, admin, i, { clientSecret: null, autoCreate: true });
    expect(saved).toMatchObject({ secretSet: true, secretFromEnv: true, ready: true });
    expect((await ssoLogin(t, i, alice)).location).toBe('/');
  });

  it('keeps the secret out of backups, and a restore keeps the live settings', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { buttonLabel: 'Before' });
    const exported = await client(t.app, admin)('GET', '/api/backup/export.json');
    expect(exported.body).not.toContain(CLIENT_SECRET);
    expect(exported.body).not.toContain('oidc_settings');

    // A hand-edited backup can't plant settings either.
    const data = exported.json();
    data.tables.settings.push({ key: 'oidc_settings', value: JSON.stringify({ enabled: true, issuer: 'https://evil.example/', clientSecret: 'x' }) });
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { buttonLabel: 'Live', clientSecret: null }));
    const boundary = '----ttoidc';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.json"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify(data)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const preview = await t.app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: admin, 'x-requested-with': CSRF_VALUE },
      payload,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const confirm = await client(t.app, admin)('POST', `/api/backup/restore/${preview.json().token}/confirm`, { confirm: 'RESTORE' });
    expect(confirm.statusCode, confirm.body).toBe(200);
    const after = (await client(t.app, admin)('GET', '/api/settings/oidc')).json();
    expect(after).toMatchObject({ buttonLabel: 'Live', issuer: i.issuer, secretSet: true, enabled: true });
  });
});

describe('signing in with single sign-on', () => {
  it('creates an account on first sign-in, then signs the same person in again', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const first = await ssoLogin(t, i, alice);
    expect(first).toMatchObject({ location: '/' });
    const me = (await client(t.app, first.session!)('GET', '/api/me')).json();
    expect(me).toMatchObject({ username: 'alice', displayName: 'Alice Liddell', role: 'member', hasPassword: false, ssoLinked: true, email: 'alice@example.com' });

    const again = await ssoLogin(t, i, alice);
    expect((await client(t.app, again.session!)('GET', '/api/me')).json().id).toBe(me.id);
    expect(t.ctx.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(2);
    // The session is a remembered one.
    const { callback, flow } = await startLogin(t, i, alice);
    const res = await browser(t, callback, [flow]);
    expect(res.cookies.find((c) => c.name === 'tt_sid')?.expires).toBeInstanceOf(Date);

    // An account made by single sign-on has no password to log in with.
    const pw = await client(t.app)('POST', '/api/auth/login', { username: 'alice', password: PASSWORD });
    expect(pw.statusCode).toBe(401);
  });

  it('picks a free username and falls back sensibly', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    await addPerson(t, admin, 'alice');
    const login = await ssoLogin(t, i, { sub: 's2', id: { preferred_username: 'Alice', name: 'Second Alice' } });
    expect((await client(t.app, login.session!)('GET', '/api/me')).json().username).toBe('alice-2');
    const odd = await ssoLogin(t, i, { sub: 's3', id: { preferred_username: '!!', email: 'Zoë.Ng@example.com', email_verified: true } });
    expect((await client(t.app, odd.session!)('GET', '/api/me')).json()).toMatchObject({ username: 'zoe.ng', displayName: 'zoe.ng' });
    const reserved = await ssoLogin(t, i, { sub: 's4', id: { preferred_username: 'tower-tracker' } });
    expect((await client(t.app, reserved.session!)('GET', '/api/me')).json().username).toBe('tower-tracker-2');
  });

  it('refuses someone new when creating accounts is off', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const res = await ssoLogin(t, i, alice);
    expect(res).toEqual({ location: '/login?sso_error=no_account', session: null });
    expect(t.ctx.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
  });

  it('refuses a bad state, a missing, tampered or expired flow cookie, and a replay', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });

    const a = await startLogin(t, i, alice);
    const forged = new URL(a.callback);
    forged.searchParams.set('state', 'not-the-state');
    const bad = await browser(t, forged.href, [a.flow]);
    expect(bad.headers.location).toBe('/login?sso_error=state');
    // The browser is told to drop the flow cookie after any callback.
    expect(bad.cookies.find((c) => c.name === 'tt_oidc')).toMatchObject({ value: '' });

    const b = await startLogin(t, i, alice);
    const noCookie = await browser(t, b.callback);
    expect(noCookie.headers.location).toBe('/login?sso_error=state');
    expect(cookieOf(noCookie, 'tt_sid')).toBeNull();

    const tampered = await startLogin(t, i, alice);
    const [name, value] = tampered.flow.split('=') as [string, string];
    const flipped = `${name}=${value.slice(0, 20)}${value[20] === 'A' ? 'B' : 'A'}${value.slice(21)}`;
    expect((await browser(t, tampered.callback, [flipped])).headers.location).toBe('/login?sso_error=state');

    // The provider's code works once, so replaying a finished callback fails there.
    const c = await startLogin(t, i, alice);
    expect((await browser(t, c.callback, [c.flow])).headers.location).toBe('/');
    const replay = await browser(t, c.callback, [c.flow]);
    expect(replay.headers.location).toBe('/login?sso_error=idp');
    expect(cookieOf(replay, 'tt_sid')).toBeNull();

    const d = await startLogin(t, i, alice);
    t.clock.advance(11 * 60 * 1000);
    expect((await browser(t, d.callback, [d.flow])).headers.location).toBe('/login?sso_error=state');
  });

  it('keeps sign-ins in a sealed cookie: a flood of starts cancels nothing, a restart cancels what was under way', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const start = await browser(t, '/api/auth/oidc/start');
    const sealed = start.cookies.find((c) => c.name === 'tt_oidc')!.value;
    // Nothing readable in it: no state, nonce or PKCE verifier in the clear.
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    expect(sealed).not.toContain(state);
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain(state);

    const oldest = await startLogin(t, i, alice);
    for (let n = 0; n < 600; n++) await browser(t, '/api/auth/oidc/start');
    expect((await browser(t, oldest.callback, [oldest.flow])).headers.location).toBe('/');

    // Another server process (a restart) has another key, so it can't open this one's cookies.
    const other = await app();
    await enableSso(other.t, other.admin, i, { autoCreate: true });
    const pending = await startLogin(t, i, alice);
    expect((await browser(other.t, pending.callback, [pending.flow])).headers.location).toBe('/login?sso_error=state');
  });

  it('refuses an ID token whose signature doesn’t match the provider’s keys', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    i.signing = 'wrong-key';
    expect(await ssoLogin(t, i, alice)).toEqual({ location: '/login?sso_error=idp', session: null });
    expect(t.ctx.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
    expect(t.logLines.join('\n')).toMatch(/signature/i);
  });

  it('refuses an HS256 ID token, and the log says how to fix it', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    i.signing = 'hs256';
    // Whether or not the provider admits to HS256 in its metadata.
    for (const algs of [['RS256'], ['HS256'], ['RS256', 'HS256']]) {
      i.algs = algs;
      await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { autoCreate: true, clientSecret: null })); // rediscover
      t.logLines.length = 0;
      expect(await ssoLogin(t, i, alice), algs.join(',')).toEqual({ location: '/login?sso_error=idp', session: null });
      expect(t.logLines.join('\n'), algs.join(',')).toContain('HS256');
    }
    expect(t.ctx.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
  });

  it('sets the flow cookie httpOnly, Lax and short-lived, only for the sign-in routes', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const start = await browser(t, '/api/auth/oidc/start');
    const c = start.cookies.find((x) => x.name === 'tt_oidc')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc', maxAge: 600 });
  });

  it('moves to the app’s address before starting, once', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const elsewhere = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start', headers: { host: '192.168.1.20:8080' } });
    expect(elsewhere.statusCode).toBe(302);
    expect(elsewhere.headers.location).toBe(`${APP_URL}/api/auth/oidc/start?hop=1`);
    expect(cookieOf(elsewhere, 'tt_oidc')).toBeNull();
    // A proxy that hides the host can't cause a loop.
    const hop = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start?hop=1', headers: { host: '192.168.1.20:8080' } });
    expect(hop.headers.location).toMatch(new RegExp(`^${i.origin}/authorize\\?`));
  });

  it('checks the required group on every sign-in, from userinfo too', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true, requiredGroup: 'belltower' });
    expect((await ssoLogin(t, i, alice)).location).toBe('/login?sso_error=group');
    expect(t.ctx.db.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);

    // Authelia's way: groups only in userinfo.
    const member: IdpUser = { ...alice, userinfo: { groups: ['users', 'belltower'] } };
    expect((await ssoLogin(t, i, member)).location).toBe('/');
    // Removed from the group later: refused even though the account exists.
    expect((await ssoLogin(t, i, { ...alice, userinfo: { groups: ['users'] } })).location).toBe('/login?sso_error=group');
    // Another groups claim name.
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { requiredGroup: 'belltower', groupsClaim: 'roles', clientSecret: null }));
    expect((await ssoLogin(t, i, { ...alice, id: { ...alice.id, roles: 'belltower' } })).location).toBe('/');
  });

  it('asks for the groups scope with a required group when the provider lists it (VoidAuth)', async () => {
    const { t, admin } = await app();
    const i = await idp();
    i.groupsNeedScope = true;
    i.scopesSupported = ['openid', 'profile', 'email', 'groups'];
    const member: IdpUser = { ...alice, userinfo: { groups: ['users', 'belltower'] } };
    const save = (extra: Record<string, unknown>) =>
      client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { preset: 'custom', autoCreate: true, clientSecret: null, ...extra }));

    // Without a required group, nothing extra is asked for.
    await enableSso(t, admin, i, { preset: 'custom', autoCreate: true });
    expect((await ssoLogin(t, i, member)).location).toBe('/');
    expect(i.lastScope).toBe('openid profile email');

    // With one, `groups` is added, so the provider sends them.
    await save({ requiredGroup: 'belltower' });
    expect((await ssoLogin(t, i, member)).location).toBe('/');
    expect(i.lastScope).toBe('openid profile email groups');

    // Typed scopes get it too, and never twice.
    await save({ requiredGroup: 'belltower', scopes: 'openid email' });
    expect((await ssoLogin(t, i, member)).location).toBe('/');
    expect(i.lastScope).toBe('openid email groups');
    await save({ requiredGroup: 'belltower', scopes: 'openid groups email' });
    expect((await ssoLogin(t, i, member)).location).toBe('/');
    expect(i.lastScope).toBe('openid groups email');

    // Not when the group comes from another claim: that scope may not be allowed for the client.
    await save({ requiredGroup: 'belltower', groupsClaim: 'roles' });
    expect((await ssoLogin(t, i, { ...alice, id: { ...alice.id, roles: ['belltower'] } })).location).toBe('/');
    expect(i.lastScope).toBe('openid profile email');
  });

  it('asks for no groups scope the provider doesn’t list, and the log says why the group check failed', async () => {
    const { t, admin } = await app();
    const i = await idp();
    i.groupsNeedScope = true;
    await enableSso(t, admin, i, { preset: 'custom', autoCreate: true, requiredGroup: 'belltower' });
    const member: IdpUser = { ...alice, userinfo: { groups: ['belltower'] } };

    t.logLines.length = 0;
    expect((await ssoLogin(t, i, member)).location).toBe('/login?sso_error=group');
    expect(i.lastScope).toBe('openid profile email');
    const missing = t.logLines.join('\n');
    expect(missing).toContain('no "groups" claim');
    expect(missing).toContain('preferred_username'); // the claims it did send, by name
    expect(missing).not.toContain('alice@example.com'); // never their values
    expect(missing).toContain('Scopes');

    // Groups that don't include the required one are listed.
    i.groupsNeedScope = false;
    t.logLines.length = 0;
    expect((await ssoLogin(t, i, { ...alice, userinfo: { groups: ['users', 'Belltower'] } })).location).toBe('/login?sso_error=group');
    expect(t.logLines.join('\n')).toContain('"groups" holds "users", "Belltower"; it needs "belltower"');
  });

  it('describes a failed group check briefly, quoting and capping what the provider sent', () => {
    const s = { groupsClaim: 'groups', requiredGroup: ' belltower ' } as OidcSettings;
    expect(describeGroupMiss(s, { sub: 'x', email: 'a@b.c' })).toBe(
      'the provider sent no "groups" claim (it sent: "email", "sub"). Check that Scopes includes "groups" (Belltower adds it ' +
        'itself when the provider lists it); some providers also leave the claim out for someone in no groups.',
    );
    expect(describeGroupMiss(s, { groups: [] })).toBe('"groups" holds no groups; it needs "belltower" (exact, case-sensitive).');
    expect(describeGroupMiss(s, { groups: [{ name: 'belltower' }] })).toMatch(/^"groups" isn't a name or a list of names \(it's a list of other values\)/);
    expect(describeGroupMiss(s, { groups: 7 })).toMatch(/\(it's a number\)/);
    // Inherited names don't count as sent.
    expect(describeGroupMiss({ ...s, groupsClaim: 'constructor' }, { sub: 'x' })).toMatch(/^the provider sent no "constructor" claim/);
    // Line breaks and quotes from the provider can't fake a log line.
    const sneaky = describeGroupMiss(s, { groups: ['ops"\nWARN  forged line'], 'x\ny': 1 });
    expect(sneaky).not.toContain('\n');
    expect(sneaky).toContain('"ops\\"\\nWARN  forged line"');
    const many = Array.from({ length: 25 }, (_, n) => `g${n}`);
    expect(describeGroupMiss(s, { groups: many })).toMatch(/"g19", and 5 more; it needs "belltower"/);
    const claimNames = Object.fromEntries(Array.from({ length: 45 }, (_, n) => [`c${String(n).padStart(2, '0')}`, 1]));
    expect(describeGroupMiss(s, claimNames)).toContain('"c39", and 5 more)');
    expect(withGroupsScope('openid profile', ['openid', 'groups'])).toBe('openid profile groups');
    expect(withGroupsScope('openid profile', ['openid'])).toBe('openid profile');
    expect(withGroupsScope('openid profile', undefined)).toBe('openid profile');
  });

  it('merges userinfo claims (email and name only there)', async () => {
    const { t, admin } = await app();
    const i = await idp('');
    await enableSso(t, admin, i, { preset: 'authelia', autoCreate: true });
    const login = await ssoLogin(t, i, { sub: 'bob-sub', id: { preferred_username: 'bob' }, userinfo: { name: 'Bob Builder', email: 'bob@example.com', email_verified: true } });
    expect((await client(t.app, login.session!)('GET', '/api/me')).json()).toMatchObject({ username: 'bob', displayName: 'Bob Builder', email: 'bob@example.com' });
  });

  it('refuses a deactivated person', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const first = await ssoLogin(t, i, alice);
    const id = (await client(t.app, first.session!)('GET', '/api/me')).json().id;
    await client(t.app, admin)('PATCH', `/api/users/${id}`, { disabled: true });
    expect(await ssoLogin(t, i, alice)).toEqual({ location: '/login?sso_error=disabled', session: null });
  });

  it('reports the provider’s Deny', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const start = await browser(t, '/api/auth/oidc/start');
    const res = await browser(t, i.deny(start.headers.location as string), [cookieOf(start, 'tt_oidc')!]);
    expect(res.headers.location).toBe('/login?sso_error=denied');
  });

  it('tolerates 25 seconds of clock skew, not 5 minutes', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    for (const offset of [25, -25]) {
      i.clockOffsetSec = offset;
      expect((await ssoLogin(t, i, alice)).location, `${offset}s`).toBe('/');
    }
    for (const offset of [300, -300]) {
      i.clockOffsetSec = offset;
      expect((await ssoLogin(t, i, alice)).location, `${offset}s`).toBe('/login?sso_error=clock');
    }
  });

  it('caches discovery, clears it when settings are saved, and never caches a failure', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    await ssoLogin(t, i, alice);
    await ssoLogin(t, i, alice);
    expect(i.discoveryHits).toBe(1);
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { autoCreate: true, clientSecret: null }));
    i.failDiscovery = true;
    expect((await browser(t, '/api/auth/oidc/start')).headers.location).toBe('/login?sso_error=idp');
    expect(i.discoveryHits).toBe(3); // the failed one tried both spellings of the issuer
    i.failDiscovery = false;
    expect((await ssoLogin(t, i, alice)).location).toBe('/');
    expect(i.discoveryHits).toBe(4);
  });

  it('runs one discovery for a burst of sign-ins on a cold cache', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const starts = await Promise.all(Array.from({ length: 8 }, () => browser(t, '/api/auth/oidc/start')));
    for (const s of starts) expect(s.headers.location).toMatch(new RegExp(`^${i.origin}/authorize\\?`));
    expect(i.discoveryHits).toBe(1);
  });

  it('refuses someone deactivated who comes back with a new identity and the same verified email', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const bob = await addPerson(t, admin, 'bob');
    await client(t.app, bob.cookie)('PATCH', '/api/me', { email: 'bob@example.com' });
    await client(t.app, admin)('PATCH', `/api/users/${bob.id}`, { disabled: true });
    const back: IdpUser = { sub: 'new-bob', id: { preferred_username: 'bob', email: 'Bob@example.com', email_verified: true } };
    expect(await ssoLogin(t, i, back)).toEqual({ location: '/login?sso_error=disabled', session: null });
    // Linking by email doesn't open a way back either.
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { autoCreate: true, linkByEmail: true, clientSecret: null }));
    expect((await ssoLogin(t, i, back)).location).toBe('/login?sso_error=disabled');
    expect(t.ctx.db.prepare("SELECT count(*) FROM users WHERE username LIKE 'bob%'").pluck().get()).toBe(1);
  });

  it('lands on the login page, not a JSON error, when finishing the sign-in fails', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    // A "verified" email the users table would refuse is simply left out.
    const odd = await ssoLogin(t, i, { sub: 'odd', id: { preferred_username: 'odd', email: '@', email_verified: true } });
    expect((await client(t.app, odd.session!)('GET', '/api/me')).json()).toMatchObject({ username: 'odd', email: null });
    // Anything else that goes wrong while making the account.
    t.ctx.db.exec("CREATE TEMP TRIGGER no_new_users BEFORE INSERT ON main.users BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const { callback, flow } = await startLogin(t, i, { sub: 'new', id: { preferred_username: 'newbie' } });
    const res = await browser(t, callback, [flow]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?sso_error=idp');
    expect(cookieOf(res, 'tt_sid')).toBeNull();
  });

  it('password login stays available while single sign-on is on', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    await i.close();
    idps = [];
    expect((await browser(t, '/api/auth/oidc/start')).headers.location).toBe('/login?sso_error=idp');
    expect(await loginAs(t, 'admin')).toMatch(/^tt_sid=/);
  });
});

describe('linking by email', () => {
  const verified = (email: string, sub = 'mail-sub'): IdpUser => ({ sub, id: { preferred_username: 'someone', email, email_verified: true } });

  it('is off by default', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const sam = await addPerson(t, admin, 'sam');
    await client(t.app, sam.cookie)('PATCH', '/api/me', { email: 'sam@example.com' });
    expect((await ssoLogin(t, i, verified('sam@example.com'))).location).toBe('/login?sso_error=no_account');
  });

  it('links the one active member with that verified email', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { linkByEmail: true });
    const sam = await addPerson(t, admin, 'sam');
    await client(t.app, sam.cookie)('PATCH', '/api/me', { email: 'Sam@Example.com' });
    // Not verified: no link.
    expect((await ssoLogin(t, i, { sub: 'x', id: { email: 'sam@example.com', email_verified: false } })).location).toBe('/login?sso_error=no_account');
    // Only a real boolean counts, not the string "true".
    expect((await ssoLogin(t, i, { sub: 'y', id: { email: 'sam@example.com', email_verified: 'true' } })).location).toBe('/login?sso_error=no_account');
    const login = await ssoLogin(t, i, verified('sam@example.com'));
    expect(login.location).toBe('/');
    expect((await client(t.app, login.session!)('GET', '/api/me')).json()).toMatchObject({ id: sam.id, ssoLinked: true });
  });

  it('never links an admin, and not when several people share the email', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { linkByEmail: true, autoCreate: true });
    await client(t.app, admin)('PATCH', '/api/me', { email: 'owner@example.com' });
    expect((await ssoLogin(t, i, verified('owner@example.com', 'a'))).location).toBe('/login?sso_error=link_required');
    expect(t.ctx.db.prepare('SELECT oidc_subject FROM users WHERE username = ?').pluck().get('admin')).toBeNull();

    const one = await addPerson(t, admin, 'one');
    const two = await addPerson(t, admin, 'two');
    await client(t.app, one.cookie)('PATCH', '/api/me', { email: 'shared@example.com' });
    await client(t.app, two.cookie)('PATCH', '/api/me', { email: 'shared@example.com' });
    expect((await ssoLogin(t, i, verified('shared@example.com', 'b'))).location).toBe('/login?sso_error=link_required');
    expect(t.ctx.db.prepare('SELECT count(*) FROM users WHERE oidc_subject IS NOT NULL').pluck().get()).toBe(0);

    // A deactivated namesake doesn't count.
    await client(t.app, admin)('PATCH', `/api/users/${two.id}`, { disabled: true });
    const login = await ssoLogin(t, i, verified('shared@example.com', 'c'));
    expect((await client(t.app, login.session!)('GET', '/api/me')).json().id).toBe(one.id);
  });
});

describe('linking your own account', () => {
  async function linkFlow(t: TestApp, i: MockIdp, cookie: string, user: IdpUser) {
    const res = await browser(t, '/api/auth/oidc/link', [cookie], { method: 'POST', headers: { 'x-requested-with': CSRF_VALUE } });
    expect(res.statusCode, res.body).toBe(200);
    return { callback: i.authorize(res.json().url, user), flow: cookieOf(res, 'tt_oidc')! };
  }

  it('needs a session and the CSRF header', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const sam = await addPerson(t, admin, 'sam');
    const noCsrf = await browser(t, '/api/auth/oidc/link', [sam.cookie], { method: 'POST' });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('csrf');
    const noSession = await browser(t, '/api/auth/oidc/link', [], { method: 'POST', headers: { 'x-requested-with': CSRF_VALUE } });
    expect(noSession.statusCode).toBe(401);
    const crossSite = await browser(t, '/api/auth/oidc/link', [sam.cookie], { method: 'POST', headers: { 'x-requested-with': CSRF_VALUE, origin: 'https://evil.example' } });
    expect(crossSite.statusCode).toBe(403);
    const unlink = await browser(t, '/api/auth/oidc/link', [sam.cookie], { method: 'DELETE' });
    expect(unlink.statusCode).toBe(403);
  });

  it('links, signs in with it, and unlinks', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i);
    const sam = await addPerson(t, admin, 'sam');
    const { callback, flow } = await linkFlow(t, i, sam.cookie, alice);
    const done = await browser(t, callback, [flow, sam.cookie]);
    expect(done.headers.location).toBe('/account?sso=linked');
    expect((await client(t.app, sam.cookie)('GET', '/api/me')).json().ssoLinked).toBe(true);

    const login = await ssoLogin(t, i, alice);
    expect((await client(t.app, login.session!)('GET', '/api/me')).json().id).toBe(sam.id);

    const again = await browser(t, '/api/auth/oidc/link', [sam.cookie], { method: 'POST', headers: { 'x-requested-with': CSRF_VALUE } });
    expect(again.json().error).toBe('already_linked');
    expect((await client(t.app, sam.cookie)('DELETE', '/api/auth/oidc/link')).statusCode).toBe(204);
    expect((await client(t.app, sam.cookie)('GET', '/api/me')).json().ssoLinked).toBe(false);
    expect((await ssoLogin(t, i, alice)).location).toBe('/login?sso_error=no_account');
  });

  it('refuses an identity someone else has, a changed session, the wrong host, and unlinking without a password', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { autoCreate: true });
    const created = await ssoLogin(t, i, alice); // alice-sub now belongs to "alice"
    const sam = await addPerson(t, admin, 'sam');

    const taken = await linkFlow(t, i, sam.cookie, alice);
    expect((await browser(t, taken.callback, [taken.flow, sam.cookie])).headers.location).toBe('/account?sso_error=taken');

    const signedOut = await linkFlow(t, i, sam.cookie, { sub: 'sam-sub' });
    expect((await browser(t, signedOut.callback, [signedOut.flow])).headers.location).toBe('/account?sso_error=link_session');
    const otherPerson = await linkFlow(t, i, sam.cookie, { sub: 'sam-sub' });
    expect((await browser(t, otherPerson.callback, [otherPerson.flow, admin])).headers.location).toBe('/account?sso_error=link_session');
    expect((await client(t.app, sam.cookie)('GET', '/api/me')).json().ssoLinked).toBe(false);

    const wrongHost = await t.app.inject({
      method: 'POST',
      url: '/api/auth/oidc/link',
      headers: { host: '192.168.1.20:8080', cookie: sam.cookie, 'x-requested-with': CSRF_VALUE },
    });
    expect(wrongHost.statusCode).toBe(409);
    expect(wrongHost.json().error).toBe('wrong_host');

    const unlink = await client(t.app, created.session!)('DELETE', '/api/auth/oidc/link');
    expect(unlink.statusCode).toBe(409);
    expect(unlink.json().error).toBe('needs_password');
  });

  it('refuses linking outside the required group, and logs why', async () => {
    const { t, admin } = await app();
    const i = await idp();
    await enableSso(t, admin, i, { requiredGroup: 'belltower' });
    const sam = await addPerson(t, admin, 'sam');
    t.logLines.length = 0;
    const { callback, flow } = await linkFlow(t, i, sam.cookie, alice);
    expect((await browser(t, callback, [flow, sam.cookie])).headers.location).toBe('/account?sso_error=group');
    expect(t.logLines.join('\n')).toMatch(/link refused \(group\) for "sam": the provider sent no "groups" claim/);
    expect((await client(t.app, sam.cookie)('GET', '/api/me')).json().ssoLinked).toBe(false);

    // A provider that sends groups only for the scope: linking asks for it too, and then works.
    i.groupsNeedScope = true;
    i.scopesSupported = ['openid', 'profile', 'email', 'groups'];
    await client(t.app, admin)('PUT', '/api/settings/oidc', settingsBody(i, { requiredGroup: 'belltower', clientSecret: null })); // rediscover
    const member = await linkFlow(t, i, sam.cookie, { ...alice, userinfo: { groups: ['belltower'] } });
    expect(i.lastScope).toBe('openid profile email groups');
    expect((await browser(t, member.callback, [member.flow, sam.cookie])).headers.location).toBe('/account?sso=linked');
  });

  it('answers 409 when single sign-on is off', async () => {
    const { t, admin } = await app();
    const res = await browser(t, '/api/auth/oidc/link', [admin], { method: 'POST', headers: { 'x-requested-with': CSRF_VALUE } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('sso_off');
  });
});
