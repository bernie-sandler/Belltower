// API tokens for Uptime Kuma, scripts, Home Assistant… A new token is shown once, with
// ready-to-use examples. Read-only tokens are for dashboards: they can only read
// GET /api/v1/summary. A token acts as the person who made it. Two places show it:
// Settings → Automation (admins: everyone's tokens, with whose each is) and Account → Your tokens
// (`mine`: only your own).

import type { ApiTokenInfo, TokenScope } from '@tt/shared';
import { Copy, Plug } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useIsAdmin, useMe } from '../../api/me';
import { useSettings, useTokenActions, useTokens } from '../../api/settings';
import { copyText } from '../../lib/clipboard';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';

export function TokensSection({ mine = false }: { mine?: boolean }) {
  const now = useNow();
  const { data: all } = useTokens();
  const { data: me } = useMe();
  const isAdmin = useIsAdmin();
  // Admins get everyone's tokens from the server; members only their own.
  const tokens = mine ? all?.filter((t) => t.owner !== null && t.owner.id === me?.id) : all;
  const { data: settings } = useSettings();
  const { create, revoke } = useTokenActions();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('full');
  const [canComplete, setCanComplete] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; info: ApiTokenInfo } | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = settings?.general.appUrl || window.location.origin;
  // "localhost" only works on this computer; a monitor on another machine needs this machine's address.
  const local = !settings?.general.appUrl && /^(localhost|127\.|\[::1\])/.test(window.location.hostname);

  const copy = (text: string, what: string) =>
    void copyText(text).then((ok) => toast(ok ? `${what} copied` : 'Couldn’t copy; select it instead', { kind: ok ? 'success' : 'warning' }));

  return (
    <section className="settings-block">
      <h3 className="card-section-title">
        <Plug size={16} aria-hidden /> {mine ? 'Your tokens' : 'Automation'}
      </h3>
      <p className="muted">
        Tokens let monitoring tools and scripts open tickets (<code>POST {base}/api/v1/cards</code>). A repeated alert with the same{' '}
        <code>dedupeKey</code> adds a note to the open ticket instead of a new one. Dashboards like Homepage or Home Assistant can
        show ticket counts from <code>GET {base}/api/v1/summary</code> with a read-only token. See <code>docs/AUTOMATION.md</code>{' '}
        for recipes.
      </p>
      <p className="muted">
        {mine
          ? 'A token acts as you: the history shows what it did as “via API token” with your name. It stops working while your account is deactivated.'
          : 'A token acts as the person who made it, and stops working while they’re deactivated. This list has everyone’s tokens; each person also sees their own under Account.'}
      </p>

      {fresh && (
        <div className="token-fresh">
          {/* Only this line is announced, not the examples below it. */}
          <p role="status">
            <strong>Copy this token now.</strong> It won’t be shown again.
          </p>
          <div className="settings-link">
            <code className="settings-link-url">{fresh.token}</code>
            <button type="button" className="btn btn-sm" onClick={() => copy(fresh.token, 'Token')}>
              <Copy size={14} aria-hidden /> Copy
            </button>
          </div>
          {local && (
            <p className="import-warning small">
              These examples use <code>{base}</code>, which only works on this computer. From another machine (like the one
              running {fresh.info.scope === 'read' ? 'your dashboard' : 'Uptime Kuma'}), use this computer’s address instead, e.g.{' '}
              <code>http://192.168.1.50:{window.location.port || '80'}</code>
              {isAdmin ? ', or set “This app’s address” under Settings → General.' : ', or ask an admin to set “This app’s address” in Settings.'}
            </p>
          )}
          {fresh.info.scope === 'read' ? <DashboardExamples base={base} token={fresh.token} /> : <TicketExamples base={base} token={fresh.token} />}
          <div className="editor-actions">
            <button type="button" className="btn btn-sm" onClick={() => setFresh(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="token-list">
          {tokens.map((t) => (
            <li key={t.id} className={t.revokedAt ? 'is-revoked' : undefined}>
              <span className="token-name">{t.name}</span>
              <code className="muted">{t.prefix}…</code>
              {!mine && <TokenOwner owner={t.owner} />}
              <span className="muted small">
                {t.scope === 'read' && 'read-only · '}
                {t.canComplete && 'can complete · '}
                {t.revokedAt
                  ? `revoked ${formatDateTime(t.revokedAt, now)}`
                  : t.lastUsedAt
                    ? `last used ${formatDateTime(t.lastUsedAt, now)}`
                    : 'never used'}
              </span>
              {!t.revokedAt && (
                <button type="button" className="btn btn-sm btn-subtle" onClick={() => setRevoking(t)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="token-new"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate(
            { name, scope, canComplete: scope === 'full' && canComplete },
            {
              onSuccess: (r) => {
                setFresh(r);
                setName('');
                setScope('full');
                setCanComplete(false);
              },
              onError: (err) => setError(errorMessage(err)),
            },
          );
        }}
      >
        <label className="field">
          <span className="field-label">New token for</span>
          <input
            className="input"
            placeholder={scope === 'read' ? 'Homepage' : 'Uptime Kuma'}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="ticket-fieldset">
          <legend className="field-label">It may</legend>
          <label className="checkbox">
            <input type="radio" name="token-scope" checked={scope === 'full'} onChange={() => setScope('full')} />
            <span>Open tickets (monitors, scripts)</span>
          </label>
          <label className="checkbox">
            <input type="radio" name="token-scope" checked={scope === 'read'} onChange={() => setScope('read')} />
            <span>Only read ticket counts (read-only, for dashboards)</span>
          </label>
        </fieldset>
        {scope === 'full' && (
          <label className="checkbox">
            <input type="checkbox" checked={canComplete} onChange={(e) => setCanComplete(e.target.checked)} />
            <span>Recoveries may mark the ticket done (otherwise they only add a note)</span>
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-actions">
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            Create token
          </button>
        </div>
      </form>

      {revoking && (
        <ConfirmDialog
          title={`Revoke “${revoking.name}”?`}
          message={
            revoking.scope === 'read'
              ? 'Anything using this token stops being able to read ticket counts.'
              : 'Anything using this token stops being able to open tickets.'
          }
          danger
          confirmLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
        />
      )}
    </section>
  );
}

/** Whose token it is (Settings → Automation). A deactivated owner's tokens are stopped, not revoked. */
function TokenOwner({ owner }: { owner: ApiTokenInfo['owner'] }) {
  if (!owner) return <span className="muted small token-owner">nobody’s</span>;
  return (
    <span className="small token-owner" title={`@${owner.username}`}>
      {owner.displayName}
      {owner.disabled && <span className="muted"> (deactivated: stopped)</span>}
    </span>
  );
}

/** For a token that opens tickets: Uptime Kuma, curl and PowerShell. */
function TicketExamples({ base, token }: { base: string; token: string }) {
  return (
    <>
      <p className="field-label">Uptime Kuma: Notification type “Webhook”, POST URL</p>
      <code className="settings-link-url">{`${base}/api/v1/hooks/uptime-kuma?labels=Monitoring`}</code>
      <p className="field-label">with Additional Headers</p>
      <code className="settings-link-url">{`{ "Authorization": "Bearer ${token}" }`}</code>
      <p className="field-label">curl (Linux, macOS, Unraid)</p>
      <pre className="token-example">{`curl -X POST ${base}/api/v1/cards \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'`}</pre>
      <p className="field-label">PowerShell (Windows)</p>
      <pre className="token-example">{`Invoke-RestMethod -Method Post -Uri "${base}/api/v1/cards" \`
  -Headers @{ Authorization = "Bearer ${token}" } \`
  -ContentType "application/json" \`
  -Body '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'`}</pre>
    </>
  );
}

/** For a read-only token: Homepage and Home Assistant, which call the summary from their own server. */
function DashboardExamples({ base, token }: { base: string; token: string }) {
  return (
    <>
      <p className="field-label">Homepage: an environment variable for its container</p>
      <pre className="token-example">{`HOMEPAGE_VAR_BELLTOWER_TOKEN=${token}`}</pre>
      <p className="field-label">and a service in one of your groups in services.yaml</p>
      <pre className="token-example">{`- Belltower:
    href: ${base}
    widget:
      type: customapi
      url: ${base}/api/v1/summary
      refreshInterval: 60000
      headers:
        Authorization: Bearer {{HOMEPAGE_VAR_BELLTOWER_TOKEN}}
      mappings:
        - field: open
          label: Open
        - field: urgent
          label: Urgent
        - field: overdue
          label: Overdue
        - field: completedToday
          label: Done today`}</pre>
      <p className="field-label">Home Assistant: secrets.yaml</p>
      <pre className="token-example">{`belltower_token: "Bearer ${token}"`}</pre>
      <p className="field-label">and configuration.yaml</p>
      <pre className="token-example">{`rest:
  - resource: ${base}/api/v1/summary
    scan_interval: 60
    headers:
      Authorization: !secret belltower_token
    sensor:
      - name: Belltower open tickets
        value_template: "{{ value_json.open }}"
        unit_of_measurement: tickets
      - name: Belltower urgent tickets
        value_template: "{{ value_json.urgent }}"
        unit_of_measurement: tickets
      - name: Belltower overdue
        value_template: "{{ value_json.overdue }}"
        unit_of_measurement: cards`}</pre>
      <p className="field-label">curl</p>
      <pre className="token-example">{`curl -H "Authorization: Bearer ${token}" ${base}/api/v1/summary`}</pre>
    </>
  );
}
