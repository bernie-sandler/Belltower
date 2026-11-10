// The network side of single sign-on, with openid-client: discovery (cached), the sign-ins waiting
// for the provider to send someone back, and the code exchange. Authorization code flow with PKCE
// (S256), state and nonce, response_mode=query. One instance per app (see routes/oidc.ts).

import { createHash, randomBytes } from 'node:crypto';
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

/** How long someone has to get through the provider's login page. Also the flow cookie's lifetime. */
export const FLOW_TTL_MS = 10 * 60 * 1000;
/** Started sign-ins kept at once; past this the oldest are dropped (a flood can't grow memory). */
export const MAX_FLOWS = 500;
/** A discovered provider is trusted this long before discovery runs again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Seconds to wait for the provider on each request. */
const TIMEOUT_SEC = 10;

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

/** A sentence for an admin about why discovery (or another provider request) failed. */
export function describeOidcError(err: unknown, issuer: string): string {
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
    case 'OAUTH_UNSUPPORTED_OPERATION':
      return 'The provider signs its ID tokens in a way Belltower doesn’t accept (HS256 with the client secret). In Authentik, choose a signing key for the provider.';
  }
  if (err instanceof TypeError) {
    const reason = (err.cause as { code?: unknown; message?: unknown } | undefined) ?? {};
    const detail = typeof reason.code === 'string' ? reason.code : typeof reason.message === 'string' ? reason.message : err.message;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail)) {
      return `The provider’s HTTPS certificate isn’t trusted (${detail}). Use a certificate from a public CA, or give the container your CA with NODE_EXTRA_CA_CERTS.`;
    }
    return `Couldn’t reach ${hostOf(issuer)} (${detail}).`;
  }
  return err instanceof Error ? err.message : 'Something went wrong talking to the provider.';
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

export class OidcRuntime {
  private readonly cache = new Map<string, { config: client.Configuration; at: number }>();
  private readonly flows = new Map<string, PendingFlow>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Forget every discovered provider (the settings changed). */
  clearCache(): void {
    this.cache.clear();
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
    return config;
  }

  /** The discovered provider for these settings, from the cache when fresh. A failure is never cached. */
  async configuration(s: OidcClientSettings): Promise<client.Configuration> {
    const key = [s.issuer, s.clientId, createHash('sha256').update(s.clientSecret).digest('hex'), s.allowHttpIssuer ? 'http' : 'https'].join('\n');
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
    const config = await this.discover(s);
    this.cache.set(key, { config, at: this.now() });
    return config;
  }

  /** Starts a sign-in: remembers the flow and returns its id (for the cookie) and the provider's address. */
  async begin(
    s: OidcClientSettings & { scopes: string },
    flow: { mode: PendingFlow['mode']; userId: number | null; redirectUri: string },
  ): Promise<{ flowId: string; url: URL }> {
    const config = await this.configuration(s);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: flow.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: s.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const flowId = randomBytes(32).toString('base64url');
    this.remember(flowId, { ...flow, state, nonce, codeVerifier, createdAt: this.now() });
    return { flowId, url };
  }

  private remember(flowId: string, flow: PendingFlow): void {
    const now = this.now();
    for (const [id, f] of this.flows) {
      if (now - f.createdAt >= FLOW_TTL_MS) this.flows.delete(id);
    }
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    this.flows.set(flowId, flow);
  }

  /**
   * The flow a callback belongs to: its cookie must name a live flow whose state matches the one
   * the provider sent back. Each flow is used once.
   */
  takeFlow(flowId: string | undefined, state: unknown): PendingFlow | null {
    if (!flowId) return null;
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    this.flows.delete(flowId);
    if (this.now() - flow.createdAt >= FLOW_TTL_MS) return null;
    if (typeof state !== 'string' || !safeEqual(state, flow.state)) return null;
    return flow;
  }

  /** How many sign-ins are waiting (for tests). */
  get pendingFlows(): number {
    return this.flows.size;
  }

  /**
   * Finishes a sign-in: exchanges the code (with the redirect URI the flow started with), checks
   * the ID token, then merges in the userinfo claims (Authelia keeps email and groups out of the ID
   * token). Throws openid-client's errors; ssoErrorCode() turns them into a code.
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
