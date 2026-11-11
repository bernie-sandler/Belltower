// Settings → Single sign-on (admins): sign in with Authentik, Authelia or another OpenID Connect
// provider. The client secret is write-only; password login always stays. See docs/SSO.md.

import { OIDC_PRESET_DEFAULTS, OIDC_PRESETS, type OidcPreset, type OidcSettingsInfo, type OidcTestResult } from '@tt/shared';
import { Copy, KeyRound, PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { useOidcSettings, useSaveOidc, useTestOidc } from '../../api/oidc';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../lib/toast';
import { Section } from './SettingsPage';

const PRESET_NAMES: Record<OidcPreset, string> = { authentik: 'Authentik', authelia: 'Authelia', custom: 'Custom' };

const ISSUER_PLACEHOLDER: Record<OidcPreset, string> = {
  authentik: 'https://auth.example.com/application/o/belltower/',
  authelia: 'https://auth.example.com',
  custom: 'https://id.example.com/realms/home',
};

const icon = <KeyRound size={16} aria-hidden />;
const TITLE = 'Single sign-on';

export function SsoSection() {
  const settings = useOidcSettings();
  if (settings.isPending) {
    return (
      <Section icon={icon} title={TITLE}>
        <p className="muted">Loading…</p>
      </Section>
    );
  }
  if (!settings.data) {
    // The demo answers "not available"; that's its notice.
    return (
      <Section icon={icon} title={TITLE}>
        <p className={isApiError(settings.error, 'demo_unavailable') ? 'notice' : 'form-error'} role="status">
          {errorMessage(settings.error)}
        </p>
      </Section>
    );
  }
  return <SsoForm info={settings.data} />;
}

function SsoForm({ info }: { info: OidcSettingsInfo }) {
  const save = useSaveOidc();
  const test = useTestOidc();
  const [enabled, setEnabled] = useState(info.enabled);
  const [preset, setPreset] = useState<OidcPreset>(info.preset);
  const [issuer, setIssuer] = useState(info.issuer);
  const [clientId, setClientId] = useState(info.clientId);
  const [secret, setSecret] = useState('');
  const [forgetSecret, setForgetSecret] = useState(false);
  const [buttonLabel, setButtonLabel] = useState(info.buttonLabel);
  const [scopes, setScopes] = useState(info.scopes);
  const [usernameClaim, setUsernameClaim] = useState(info.usernameClaim);
  const [groupsClaim, setGroupsClaim] = useState(info.groupsClaim);
  const [requiredGroup, setRequiredGroup] = useState(info.requiredGroup);
  const [autoCreate, setAutoCreate] = useState(info.autoCreate);
  const [linkByEmail, setLinkByEmail] = useState(info.linkByEmail);
  const [allowHttpIssuer, setAllowHttpIssuer] = useState(info.allowHttpIssuer);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<OidcTestResult | null>(null);
  // The server normalizes the issuer (the preset's trailing slash): show what it saved.
  useEffect(() => setIssuer(info.issuer), [info.issuer]);
  useEffect(() => setEnabled(info.enabled), [info.enabled]);

  const custom = preset === 'custom';
  const claimFields = (
    <>
      <label className="field">
        <span className="field-label">Scopes</span>
        <input
          className="input input-mono"
          value={scopes}
          placeholder={OIDC_PRESET_DEFAULTS[preset].scopes}
          onChange={(e) => setScopes(e.target.value)}
          spellCheck={false}
        />
        <span className="field-help">Separated by spaces. Empty uses {OIDC_PRESET_DEFAULTS[preset].scopes}.</span>
      </label>
      <label className="field">
        <span className="field-label">Username claim</span>
        <input className="input input-mono" value={usernameClaim} onChange={(e) => setUsernameClaim(e.target.value)} spellCheck={false} />
        <span className="field-help">Names new accounts (made URL-safe, with -2, -3… if taken).</span>
      </label>
      <label className="field">
        <span className="field-label">Groups claim</span>
        <input className="input input-mono" value={groupsClaim} onChange={(e) => setGroupsClaim(e.target.value)} spellCheck={false} />
      </label>
    </>
  );

  function onSave() {
    setError(null);
    save.mutate(
      {
        enabled,
        preset,
        buttonLabel,
        issuer,
        clientId,
        clientSecret: forgetSecret ? '' : secret.trim() || null,
        scopes,
        usernameClaim: usernameClaim.trim() || 'preferred_username',
        groupsClaim: groupsClaim.trim() || 'groups',
        requiredGroup,
        autoCreate,
        linkByEmail,
        allowHttpIssuer,
      },
      {
        onSuccess: () => {
          setSecret('');
          setForgetSecret(false);
          toast('Saved', { kind: 'success', durationMs: 2000 });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  function onTest() {
    setTestResult(null);
    setError(null);
    test.mutate(
      { preset, issuer, allowHttpIssuer },
      { onSuccess: setTestResult, onError: (err) => setTestResult({ ok: false, issuer: null, message: errorMessage(err) }) },
    );
  }

  return (
    <Section icon={icon} title={TITLE}>
      <p className="muted">
        Let people sign in with your identity provider. Password login always stays available, so a broken provider can’t lock
        anyone out.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Turn on single sign-on</span>
      </label>

      <div className="segmented" role="radiogroup" aria-label="Provider">
        {OIDC_PRESETS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={preset === p} className="segmented-item" onClick={() => setPreset(p)}>
            {PRESET_NAMES[p]}
          </button>
        ))}
      </div>
      <PresetHelp preset={preset} redirectUri={info.redirectUri} clientId={clientId} />

      <div className="field">
        <span className="field-label">Redirect URI</span>
        {info.redirectUri ? (
          <div className="settings-link">
            <code className="settings-link-url">{info.redirectUri}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void copyText(info.redirectUri!).then((ok) =>
                  toast(ok ? 'Redirect URI copied' : 'Couldn’t copy; select it instead', { kind: ok ? 'success' : 'warning' }),
                )
              }
            >
              <Copy size={14} aria-hidden /> Copy
            </button>
          </div>
        ) : (
          <p className="notice notice-warning">Set “This app’s address” under General first: the provider sends people back to it.</p>
        )}
        {info.redirectUri && <span className="field-help">Register exactly this at the provider.</span>}
      </div>

      <label className="field">
        <span className="field-label">Issuer URL</span>
        <input
          className="input input-mono"
          type="url"
          value={issuer}
          placeholder={ISSUER_PLACEHOLDER[preset]}
          onChange={(e) => setIssuer(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span className="field-label">Client ID</span>
        <input className="input input-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="field">
        <span className="field-label">Client secret</span>
        <input
          className="input input-mono"
          type="password"
          value={info.secretFromEnv ? '' : secret}
          disabled={info.secretFromEnv || forgetSecret}
          placeholder={info.secretFromEnv ? 'Set by OIDC_CLIENT_SECRET' : info.secretSet ? 'Saved (leave empty to keep it)' : ''}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="new-password"
        />
        <span className="field-help">
          {info.secretFromEnv
            ? 'Comes from OIDC_CLIENT_SECRET (or _FILE) in the container’s environment, which wins over a saved one.'
            : info.secretSet
              ? 'A secret is saved. It’s never shown again.'
              : 'Never shown again once saved.'}
        </span>
      </label>
      {info.secretSet && !info.secretFromEnv && (
        <label className="checkbox">
          <input type="checkbox" checked={forgetSecret} onChange={(e) => setForgetSecret(e.target.checked)} />
          <span>Forget the saved secret</span>
        </label>
      )}
      <label className="field">
        <span className="field-label">Button label</span>
        <input className="input" maxLength={40} value={buttonLabel} placeholder={OIDC_PRESET_DEFAULTS[preset].label} onChange={(e) => setButtonLabel(e.target.value)} />
        <span className="field-help">The login page shows “Sign in with {buttonLabel.trim() || OIDC_PRESET_DEFAULTS[preset].label}”.</span>
      </label>
      <label className="field">
        <span className="field-label">Required group (optional)</span>
        <input className="input" value={requiredGroup} onChange={(e) => setRequiredGroup(e.target.value)} spellCheck={false} />
        <span className="field-help">
          Only members of this group get in. Checked at every sign-in, so removing someone from it locks them out. The provider must send it in the
          groups claim; some send that only for the <code>groups</code> scope.
        </span>
      </label>

      {custom ? (
        claimFields
      ) : (
        <details className="settings-subblock">
          <summary className="muted small">Scopes and claims</summary>
          {claimFields}
        </details>
      )}

      <label className="checkbox">
        <input type="checkbox" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
        <span>Create accounts on first sign-in</span>
      </label>
      <p className="field-help">
        New people become members. Off: an admin adds people first, and they link themselves under Account. With it on, the
        provider decides who gets in: remove someone from the required group there to keep them out.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={linkByEmail} onChange={(e) => setLinkByEmail(e.target.checked)} />
        <span>Link existing accounts by verified email</span>
      </label>
      <p className="field-help">
        A first sign-in joins the one active account with the same email, if the provider says it’s verified. Never an admin, and
        not when several accounts share it.
      </p>
      <p className="notice notice-warning">
        Only turn this on if people can’t change their own email at the provider. It trusts the provider’s “email verified”:
        anyone who can set someone else’s address there could take over that person’s Belltower account.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={allowHttpIssuer} onChange={(e) => setAllowHttpIssuer(e.target.checked)} />
        <span>Allow a plain-HTTP issuer (LAN only)</span>
      </label>
      {allowHttpIssuer && (
        <p className="notice notice-warning">The client secret and tokens then cross the network unencrypted. Use it only on a network you trust.</p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {testResult && (
        <p className={testResult.ok ? 'notice' : 'form-error'} role="status">
          {testResult.message}
        </p>
      )}
      <div className="editor-actions">
        <button type="button" className="btn" disabled={!issuer.trim() || test.isPending} onClick={onTest}>
          <PlugZap size={14} aria-hidden /> {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={onSave}>
          Save
        </button>
      </div>
    </Section>
  );
}

function PresetHelp({ preset, redirectUri, clientId }: { preset: OidcPreset; redirectUri: string | null; clientId: string }) {
  const uri = redirectUri ?? 'https://belltower.example.com/api/auth/oidc/callback';
  if (preset === 'authentik') {
    return (
      <p className="field-help">
        In Authentik, create an <strong>OAuth2/OpenID Provider</strong>: client type <em>Confidential</em>, redirect URI set to{' '}
        <em>Strict</em> with the address below, and a signing key selected. Then make an application for it. The issuer is the
        provider’s <em>OpenID Configuration Issuer</em>, like <code>https://auth.example.com/application/o/&lt;slug&gt;/</code>{' '}
        (with the slash at the end).
      </p>
    );
  }
  if (preset === 'authelia') {
    const yaml = [
      'identity_providers:',
      '  oidc:',
      '    clients:',
      `      - client_id: '${clientId.trim() || 'belltower'}'`,
      "        client_name: 'Belltower'",
      "        client_secret: '$pbkdf2-sha512$310000$…'  # the hash of the secret you paste here",
      '        public: false',
      "        authorization_policy: 'two_factor'",
      '        redirect_uris:',
      `          - '${uri}'`,
      "        scopes: ['openid', 'profile', 'email', 'groups']",
      "        response_types: ['code']",
      "        grant_types: ['authorization_code']",
      '        require_pkce: true',
      "        pkce_challenge_method: 'S256'",
      "        token_endpoint_auth_method: 'client_secret_basic'",
    ].join('\n');
    return (
      <div className="settings-subblock">
        <p className="field-help">
          The issuer is Authelia’s own address, like <code>https://auth.example.com</code> (no path). Add a client to Authelia’s
          configuration (hash the secret with <code>authelia crypto hash generate pbkdf2</code>), then restart Authelia:
        </p>
        <pre className="code-block">{yaml}</pre>
      </div>
    );
  }
  return (
    <p className="field-help">
      Any OpenID Connect provider (Keycloak, Pocket ID, Zitadel, Kanidm…): register a confidential client for the authorization
      code flow with PKCE (S256) and the redirect URI below. Use the issuer exactly as the provider’s
      <code> /.well-known/openid-configuration</code> reports it.
    </p>
  );
}
