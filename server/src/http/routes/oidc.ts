// Single sign-on (OIDC): signing in with Authentik, Authelia or another provider, linking your own
// account to it (Account → Sign-in), and its settings (admins). While it's on and complete, the
// password form is hidden behind a link by default, and an admin can show it or turn password
// sign-in off (services/oidc.ts passwordLoginMode). The owner can always sign in with a password
// at /login?password, and APP_PASSWORD resets the owner's password, so a broken provider can't
// lock everyone out. See docs/SSO.md.

import { OidcSettingsBody, OidcTestBody, type OidcSettingsInfo, type OidcTestResult, type SsoErrorCode } from '@tt/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { FLOW_TTL_MS, OidcRuntime, describeOidcError, ssoErrorCode, type OidcClientSettings, type PendingFlow } from '../../auth/oidc';
import { AppError, conflict } from '../../errors';
import type { Ctx } from '../../services/context';
import {
  checkIssuer,
  clientSecretOf,
  describeGroupMiss,
  effectiveScopes,
  getOidcSettings,
  hasRequiredGroup,
  linkIdentity,
  normalizeIssuer,
  oidcInfo,
  oidcReady,
  redirectUriFor,
  resolveSignIn,
  unlinkIdentity,
  updateOidcSettings,
} from '../../services/oidc';
import { getGeneralSettings } from '../../services/settings';
import { getUser } from '../../services/users';
import { ADMIN, isSecureRequest, resolveSession } from '../guard';
import { parse } from '../util';
import { startSession } from './auth';

/** Ties a callback to the browser that started the sign-in. Only sent to the sign-in routes. */
const FLOW_COOKIE = 'tt_oidc';
const FLOW_COOKIE_PATH = '/api/auth/oidc';

export function registerOidcRoutes(app: FastifyInstance, deps: AppDeps): void {
  // The app's clock, so flow expiry follows the same time as sessions (and tests can move it).
  const runtime = new OidcRuntime(() => deps.baseCtx.clock.now().getTime());
  const envSecret = deps.config.oidcClientSecret;

  /** Settings and the redirect URI, when single sign-on is on and complete; null otherwise. */
  function ready(ctx: Ctx): { settings: OidcClientSettings & { scopes: string; groupsScope: boolean }; appUrl: string; redirectUri: string } | null {
    const s = getOidcSettings(ctx);
    if (!oidcReady(ctx, s, envSecret)) return null;
    const appUrl = getGeneralSettings(ctx).appUrl;
    return {
      settings: {
        preset: s.preset,
        issuer: normalizeIssuer(s.preset, s.issuer),
        clientId: s.clientId,
        clientSecret: clientSecretOf(s, envSecret)!,
        allowHttpIssuer: s.allowHttpIssuer,
        scopes: effectiveScopes(s),
        // Only for the claim the `groups` scope sends: another claim name may come from a scope
        // the client isn't allowed, which some providers refuse outright.
        groupsScope: s.requiredGroup.trim() !== '' && s.groupsClaim === 'groups',
      },
      appUrl,
      redirectUri: redirectUriFor(appUrl)!,
    };
  }

  const appHost = (appUrl: string) => new URL(appUrl).host;

  /** The sealed flow (state, nonce, PKCE verifier…), encrypted with a key that only this process has. */
  function setFlowCookie(req: FastifyRequest, reply: FastifyReply, sealed: string): void {
    reply.setCookie(FLOW_COOKIE, sealed, {
      path: FLOW_COOKIE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req, deps),
      maxAge: FLOW_TTL_MS / 1000,
    });
  }

  function clearFlowCookie(req: FastifyRequest, reply: FastifyReply): void {
    reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req, deps) });
  }

  /** Back to the login page (or Account, for a link) with a code the page turns into a message. */
  function failed(reply: FastifyReply, code: SsoErrorCode, mode: PendingFlow['mode'] = 'login') {
    return reply.redirect(`${mode === 'link' ? '/account' : '/login'}?sso_error=${code}`);
  }

  /**
   * Sign in with the provider. The provider sends people back to appUrl, and the flow cookie only
   * comes back to the host that set it, so a request on another address (an IP, a Tailscale name)
   * first moves to appUrl. `hop` stops a loop when a proxy hides the real host.
   */
  app.get('/api/auth/oidc/start', async (req, reply) => {
    const r = ready(req.ctx);
    if (!r) return failed(reply, 'not_configured');
    if (req.host !== appHost(r.appUrl) && (req.query as { hop?: string }).hop !== '1') {
      return reply.redirect(`${r.appUrl}/api/auth/oidc/start?hop=1`);
    }
    try {
      const { cookie, url } = await runtime.begin(r.settings, { mode: 'login', userId: null, redirectUri: r.redirectUri });
      setFlowCookie(req, reply, cookie);
      return reply.redirect(url.href);
    } catch (err) {
      req.log.warn(`Single sign-on couldn't start: ${describeOidcError(err, r.settings.issuer)}`);
      return failed(reply, 'idp');
    }
  });

  /** Where the provider sends people back. Every failure lands on the login (or Account) page. */
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const flow = runtime.openFlow(req.cookies[FLOW_COOKIE], new URLSearchParams(query).get('state'));
    clearFlowCookie(req, reply);
    if (!flow) {
      req.log.warn('Single sign-on callback without a matching sign-in (flow cookie missing, expired, from before a restart, or the state differs)');
      return failed(reply, 'state');
    }
    const r = ready(req.ctx);
    if (!r) return failed(reply, 'not_configured', flow.mode);

    let identity;
    try {
      identity = await runtime.complete(r.settings, flow, query);
    } catch (err) {
      req.log.warn(`Single sign-on failed: ${describeOidcError(err, r.settings.issuer)}`);
      return failed(reply, ssoErrorCode(err), flow.mode);
    }
    const s = getOidcSettings(req.ctx);

    // Anything unexpected from here on (a username that can't be made, a claim the database
    // refuses) still ends on the login or Account page, never as a JSON error in the browser.
    try {
      if (flow.mode === 'link') {
        // Still the same person signed in on this browser?
        const session = resolveSession(req, reply, deps);
        if (!session || session.user.id !== flow.userId) return failed(reply, 'link_session', 'link');
        // The required group applies to linking too.
        if (!hasRequiredGroup(s, identity.claims)) {
          req.log.warn(`Single sign-on link refused (group) for "${session.user.username}": ${describeGroupMiss(s, identity.claims)}`);
          return failed(reply, 'group', 'link');
        }
        if (linkIdentity(req.ctx, session.user.id, identity) === 'taken') return failed(reply, 'taken', 'link');
        req.log.info(`Single sign-on linked to "${session.user.username}"`);
        return reply.redirect('/account?sso=linked');
      }

      const outcome = resolveSignIn(req.ctx, s, identity);
      if (!outcome.ok) {
        const why = outcome.code === 'group' ? `: ${describeGroupMiss(s, identity.claims)}` : '';
        req.log.warn(`Single sign-on refused (${outcome.code}) for subject ${identity.subject}${why}`);
        return failed(reply, outcome.code);
      }
      startSession(req, reply, deps, outcome.user.id, true);
      const how = { linked: '', email: ' (linked by email)', created: ' (new account)' }[outcome.how];
      req.log.info(`"${outcome.user.username}" signed in with single sign-on${how}`);
      return reply.redirect('/');
    } catch (err) {
      req.log.error({ err }, `Single sign-on couldn't finish for subject ${identity.subject}`);
      return failed(reply, 'idp', flow.mode);
    }
  });

  /** Starts linking the signed-in person; the page then goes to the returned address. */
  app.post('/api/auth/oidc/link', async (req, reply): Promise<{ url: string }> => {
    const r = ready(req.ctx);
    if (!r) throw conflict('sso_off', 'Single sign-on isn’t set up on this install');
    if (req.host !== appHost(r.appUrl)) {
      throw conflict('wrong_host', `Open Belltower at ${r.appUrl} to link single sign-on: the provider sends you back there.`);
    }
    if (getUser(req.ctx, req.user!.id).oidc_subject !== null) {
      throw conflict('already_linked', 'Your account is already linked; unlink it first');
    }
    try {
      const { cookie, url } = await runtime.begin(r.settings, { mode: 'link', userId: req.user!.id, redirectUri: r.redirectUri });
      setFlowCookie(req, reply, cookie);
      return { url: url.href };
    } catch (err) {
      throw new AppError(502, 'sso_unreachable', describeOidcError(err, r.settings.issuer));
    }
  });

  app.delete('/api/auth/oidc/link', async (req, reply) => {
    unlinkIdentity(req.ctx, req.user!.id, envSecret);
    return reply.status(204).send();
  });

  // ---- settings (admins) ----

  app.get('/api/settings/oidc', ADMIN, async (req): Promise<OidcSettingsInfo> => oidcInfo(req.ctx, envSecret));
  app.put('/api/settings/oidc', ADMIN, async (req): Promise<OidcSettingsInfo> => {
    updateOidcSettings(req.ctx, parse(OidcSettingsBody, req.body), envSecret, req.user!.id);
    runtime.clearCache();
    return oidcInfo(req.ctx, envSecret);
  });
  /** Discovery with the form's issuer (saved or not), never cached. */
  app.post('/api/settings/oidc/test', ADMIN, async (req): Promise<OidcTestResult> => {
    const body = parse(OidcTestBody, req.body);
    const issuer = normalizeIssuer(body.preset, body.issuer);
    checkIssuer(issuer, body.allowHttpIssuer);
    try {
      const config = await runtime.discover({ preset: body.preset, issuer, clientId: '', allowHttpIssuer: body.allowHttpIssuer });
      const meta = config.serverMetadata();
      const notes: string[] = [];
      if (meta.issuer !== issuer) notes.push(`Its issuer is spelled “${meta.issuer}” (Belltower uses that spelling).`);
      if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) {
        notes.push('It doesn’t list PKCE S256, which Belltower uses; sign-in may fail.');
      }
      if (!meta.userinfo_endpoint) notes.push('It has no userinfo endpoint, so only the ID token’s claims are used.');
      return { ok: true, issuer: meta.issuer, message: [`Found ${meta.issuer}.`, ...notes].join(' ') };
    } catch (err) {
      return { ok: false, issuer: null, message: describeOidcError(err, issuer) };
    }
  });
}
