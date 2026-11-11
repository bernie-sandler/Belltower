// The network side of single sign-on, with openid-client: discovery (cached), the sealed flow
// cookie that carries a sign-in through the provider, and the code exchange. Authorization code
// flow with PKCE (S256), state and nonce, response_mode=query. One instance per app (see
// routes/oidc.ts).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import type { OidcPreset, SsoErrorCode } from '@tt/shared';
import { safeEqual } from '../lib/safeEqual';
import type { OidcIdentity } from '../services/oidc';

/** What talking to the provider needs from the settings. */
export interface OidcClientSettings {
  preset: OidcPreset;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowHttpIssuer: boolean;
}

/** A sign-in on its way through the provider. Sealed into the flow cookie; the server keeps nothing. */
export interface PendingFlow {
  /** Signing in, or linking the signed-in person (`userId`). */
  mode: 'login' | 'link';
  userId: number | null;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

/**
 * The scopes plus `groups` when the provider lists that scope in its discovery document. Used only
 * with a required group read from the `groups` claim: VoidAuth, Pocket ID and Authelia send it only
 * when it's asked for, and a provider that doesn't list it never gets it (some refuse a scope they
 * don't know).
 */
export function withGroupsScope(scopes: string, supported: unknown): string {
  const words = scopes.split(/\s+/).filter(Boolean);
  if (words.includes('groups') || !Array.isArray(supported) || !supported.includes('groups')) return scopes;
  return [...words, 'groups'].join(' ');
}

/** How long someone has to get through the provider's login page. Also the flow cookie's lifetime. */
export const FLOW_TTL_MS = 10 * 60 * 1000;
/** A discovered provider is trusted this long before discovery runs again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Seconds to wait for the provider on each request. */
const TIMEOUT_SEC = 10;
/** Binds sealed cookies to their purpose and format version. */
const FLOW_AAD = Buffer.from('tt_oidc:v1');

/** The slash at the end of the issuer, flipped: discovery's issuer check compares it exactly. */
function flipSlash(issuer: string): string {
  return issuer.endsWith('/') ? issuer.replace(/\/+$/, '') : `${issuer}/`;
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: unknown })?.code as string | undefined;
}

/** Whether discovery failed in a way the other spelling of the issuer could fix. */
function slashMightHelp(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED' || code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' || code === 'OAUTH_RESPONSE_IS_NOT_JSON';
}

/** The JWS `alg` a token was refused for, found in openid-client's chain of causes. */
function refusedAlg(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e && typeof e === 'object'; depth++) {
    const c = (e as { cause?: unknown }).cause as { alg?: unknown; header?: { alg?: unknown } } | undefined;
    if (typeof c?.alg === 'string') return c.alg;
    if (typeof c?.header?.alg === 'string') return c.header.alg;
    e = c;
  }
  return null;
}

/** The messages down openid-client's chain of causes, outermost first. */
function causeMessages(err: unknown): string[] {
  const out: string[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e instanceof Error; depth++) {
    if (e.message && !out.includes(e.message)) out.push(e.message);
    e = e.cause;
  }
  return out;
}

/** A sentence for an admin about why discovery (or another provider request) failed. */
export function describeOidcError(err: unknown, issuer: string): string {
  if (refusedAlg(err)?.startsWith('HS')) {
    return 'The provider signs its ID tokens with the client secret (HS256), which Belltower doesn’t accept. In Authentik, choose a signing key for the provider.';
  }
  const messages = causeMessages(err);
  if (messages.some((m) => /signature verification failed/i.test(m))) {
    return 'The ID token’s signature doesn’t match the provider’s published keys, so it was refused. If the provider just changed its signing key, try again.';
  }
  const code = errorCode(err);
  const cause = (err as { cause?: unknown })?.cause as Record<string, unknown> | undefined;
  switch (code) {
    case 'OAUTH_HTTP_REQUEST_FORBIDDEN':
      return 'The issuer uses http://. Use https://, or turn on “Allow a plain-HTTP issuer” (LAN only).';
    case 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED': {
      const reported = (cause?.body as { issuer?: unknown } | undefined)?.issuer;
      return typeof reported === 'string'
        ? `The provider says its issuer is “${reported}”, not “${issuer}”. Copy the issuer exactly as the provider shows it.`
        : 'The provider’s answer doesn’t match what was asked for. Check the issuer.';
    }
    case 'OAUTH_RESPONSE_IS_NOT_CONFORM': {
      const status = (cause as { status?: unknown } | undefined)?.status;
      return `The provider answered ${typeof status === 'number' ? `HTTP ${status}` : 'with an error'} at ${discoveryUrl(issuer)}. Check the issuer (for Authentik it ends in /application/o/<slug>/).`;
    }
    case 'OAUTH_RESPONSE_IS_NOT_JSON':
      return `${discoveryUrl(issuer)} didn’t return the provider’s configuration. Check the issuer.`;
    case 'OAUTH_TIMEOUT':
      return `No answer from the provider within ${TIMEOUT_SEC} seconds.`;
    case 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED':
      return 'The provider’s token is outside its valid time. Check that this server and the provider keep the right time (NTP).';
    case 'OAUTH_KEY_SELECTION_FAILED':
      return 'None of the provider’s published keys fits the ID token’s signature, so it was refused. If the provider just changed its signing key, try again.';
  }
  if (err instanceof TypeError) {
    const reason = (err.cause as { code?: unknown; message?: unknown } | undefined) ?? {};
    const detail = typeof reason.code === 'string' ? reason.code : typeof reason.message === 'string' ? reason.message : err.message;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail)) {
      return `The provider’s HTTPS certificate isn’t trusted (${detail}). Use a certificate from a public CA, or give the container your CA with NODE_EXTRA_CA_CERTS.`;
    }
    return `Couldn’t reach ${hostOf(issuer)} (${detail}).`;
  }
  // openid-client's outer messages are generic ("invalid response encountered"): add the cause.
  return messages.length ? messages.slice(0, 2).join(': ') : 'Something went wrong talking to the provider.';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** The login page's `sso_error` for a failed sign-in. Details go to the log, not the address bar. */
export function ssoErrorCode(err: unknown): SsoErrorCode {
  if (err instanceof client.AuthorizationResponseError) return err.error === 'access_denied' ? 'denied' : 'idp';
  if (errorCode(err) === 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED') return 'clock';
  return 'idp';
}

/** Whether something read back from a cookie has the shape of a flow we sealed. */
function isFlow(v: unknown): v is PendingFlow {
  const f = v as Partial<PendingFlow> | null;
  return (
    !!f &&
    (f.mode === 'login' || f.mode === 'link') &&
    (f.userId === null || Number.isInteger(f.userId)) &&
    [f.state, f.nonce, f.codeVerifier, f.redirectUri].every((s) => typeof s === 'string' && s.length > 0) &&
    typeof f.createdAt === 'number'
  );
}

export class OidcRuntime {
  private readonly cache = new Map<string, { config: client.Configuration; at: number }>();
  /** Discoveries under way, so a burst of sign-ins on a cold cache makes one request. */
  private readonly inflight = new Map<string, Promise<client.Configuration>>();
  /** Bumped by clearCache(), so a discovery that started before a save doesn't refill the cache. */
  private generation = 0;
  /** Seals flow cookies. Made at startup and never stored: a restart only cancels sign-ins under way. */
  private readonly flowKey = randomBytes(32);

  constructor(private readonly now: () => number = Date.now) {}

  /** Forget every discovered provider (the settings changed). */
  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
    this.generation++;
  }

  /**
   * Discovery, without the cache. The issuer is tried as given, then once with its trailing slash
   * flipped when the first answer suggests that's what was wrong.
   */
  async discover(s: Omit<OidcClientSettings, 'clientSecret'> & { clientSecret?: string }): Promise<client.Configuration> {
    try {
      return await this.discoverOnce(s.issuer, s);
    } catch (err) {
      if (!slashMightHelp(err)) throw err;
      try {
        return await this.discoverOnce(flipSlash(s.issuer), s);
      } catch {
        throw err; // the first error describes what was actually typed
      }
    }
  }

  private async discoverOnce(issuer: string, s: { clientId: string; clientSecret?: string; allowHttpIssuer: boolean }): Promise<client.Configuration> {
    // Undefined (Test connection, before a secret is saved) defers the check until a token request.
    const secret = s.clientSecret || undefined;
    const options: client.DiscoveryRequestOptions = {
      timeout: TIMEOUT_SEC,
      ...(s.allowHttpIssuer ? { execute: [client.allowInsecureRequests] } : {}),
    };
    let config = await client.discovery(new URL(issuer), s.clientId || 'belltower', secret, client.ClientSecretBasic(secret), options);
    // client_secret_basic is the OIDC default (and what Authelia's snippet asks for). A provider
    // that lists only client_secret_post gets that instead.
    const methods = config.serverMetadata().token_endpoint_auth_methods_supported;
    if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
      config = new client.Configuration(config.serverMetadata(), s.clientId, secret, client.ClientSecretPost(secret));
      config.timeout = TIMEOUT_SEC;
      if (s.allowHttpIssuer) client.allowInsecureRequests(config);
    }
    // openid-client trusts an ID token from the token endpoint without checking its signature
    // unless told otherwise (TLS is meant to vouch for it). Always check it against the provider's
    // published keys: a plain-HTTP issuer has no TLS, and symmetric (HS*) tokens are refused.
    client.enableNonRepudiationChecks(config);
    return config;
  }

  /** The discovered provider for these settings, from the cache when fresh. A failure is never cached. */
  async configuration(s: OidcClientSettings): Promise<client.Configuration> {
    const key = [s.issuer, s.clientId, createHash('sha256').update(s.clientSecret).digest('hex'), s.allowHttpIssuer ? 'http' : 'https'].join('\n');
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const discovery = this.discover(s)
      .then((config) => {
        if (generation === this.generation) this.cache.set(key, { config, at: this.now() });
        return config;
      })
      .finally(() => {
        if (this.inflight.get(key) === discovery) this.inflight.delete(key);
      });
    this.inflight.set(key, discovery);
    return discovery;
  }

  /**
   * Starts a sign-in: returns the sealed flow (the cookie's value) and the provider's address.
   * `groupsScope` (a required group read from the `groups` claim) also asks for `groups` when the
   * provider lists it.
   */
  async begin(
    s: OidcClientSettings & { scopes: string; groupsScope: boolean },
    flow: { mode: PendingFlow['mode']; userId: number | null; redirectUri: string },
  ): Promise<{ cookie: string; url: URL }> {
    const config = await this.configuration(s);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: flow.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: s.groupsScope ? withGroupsScope(s.scopes, config.serverMetadata().scopes_supported) : s.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { cookie: this.seal({ ...flow, state, nonce, codeVerifier, createdAt: this.now() }), url };
  }

  /** AES-256-GCM with this instance's key: iv ‖ tag ‖ ciphertext, base64url. */
  seal(flow: PendingFlow): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.flowKey, iv);
    cipher.setAAD(FLOW_AAD);
    const body = Buffer.concat([cipher.update(JSON.stringify(flow), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /**
   * The flow a callback belongs to: the cookie must open with this instance's key (not forged,
   * not from before a restart), be under 10 minutes old, and carry the state the provider sent back
   * (compared in constant time).
   */
  openFlow(cookie: string | undefined, state: unknown): PendingFlow | null {
    if (!cookie || cookie.length > 4096) return null;
    let flow: unknown;
    try {
      const raw = Buffer.from(cookie, 'base64url');
      if (raw.length < 12 + 16 + 2) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.flowKey, raw.subarray(0, 12));
      decipher.setAAD(FLOW_AAD);
      decipher.setAuthTag(raw.subarray(12, 28));
      flow = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
    if (!isFlow(flow)) return null;
    const age = this.now() - flow.createdAt;
    if (age < 0 || age >= FLOW_TTL_MS) return null;
    if (typeof state !== 'string' || !safeEqual(state, flow.state)) return null;
    return flow;
  }

  /**
   * Finishes a sign-in: exchanges the code (with the redirect URI the flow started with), checks
   * the ID token (signature included), then merges in the userinfo claims (Authelia keeps email and
   * groups out of the ID token). Throws openid-client's errors; ssoErrorCode() turns them into a
   * code. The provider's codes work once, so a replayed callback fails there.
   */
  async complete(s: OidcClientSettings, flow: PendingFlow, query: string): Promise<OidcIdentity> {
    const config = await this.configuration(s);
    const currentUrl = new URL(flow.redirectUri);
    currentUrl.search = query;
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const id = tokens.claims();
    if (!id) throw new Error('The provider sent no ID token');
    let userinfo: Record<string, unknown> = {};
    if (config.serverMetadata().userinfo_endpoint) {
      userinfo = await client.fetchUserInfo(config, tokens.access_token, id.sub);
    }
    return { issuer: id.iss, subject: id.sub, claims: { ...id, ...userinfo, iss: id.iss, sub: id.sub } };
  }
}
