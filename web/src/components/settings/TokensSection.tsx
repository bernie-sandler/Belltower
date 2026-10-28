// Settings → Automation: API tokens for Uptime Kuma, scripts, Home Assistant… A new token is shown
// once, with ready-to-use examples.

import type { ApiTokenInfo } from '@tt/shared';
import { Copy, Plug } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useSettings, useTokenActions, useTokens } from '../../api/settings';
import { copyText } from '../../lib/clipboard';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';

export function TokensSection() {
  const now = useNow();
  const { data: tokens } = useTokens();
  const { data: settings } = useSettings();
  const { create, revoke } = useTokenActions();
  const [name, setName] = useState('');
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
        <Plug size={16} aria-hidden /> Automation
      </h3>
      <p className="muted">
        Tokens let monitoring tools and scripts open tickets (<code>POST {base}/api/v1/cards</code>). A repeated alert with the same{' '}
        <code>dedupeKey</code> adds a note to the open ticket instead of a new one. See <code>docs/AUTOMATION.md</code> for recipes.
      </p>

      {fresh && (
        <div className="token-fresh" role="status">
          <p>
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
              running Uptime Kuma), use this computer’s address instead, e.g. <code>http://192.168.1.50:{window.location.port || '80'}</code>
              , or set “This app’s address” under General.
            </p>
          )}
          <p className="field-label">Uptime Kuma: Notification type “Webhook”, POST URL</p>
          <code className="settings-link-url">{`${base}/api/v1/hooks/uptime-kuma?labels=Monitoring`}</code>
          <p className="field-label">with Additional Headers</p>
          <code className="settings-link-url">{`{ "Authorization": "Bearer ${fresh.token}" }`}</code>
          <p className="field-label">curl (Linux, macOS, Unraid)</p>
          <pre className="token-example">{`curl -X POST ${base}/api/v1/cards \\
  -H "Authorization: Bearer ${fresh.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'`}</pre>
          <p className="field-label">PowerShell (Windows)</p>
          <pre className="token-example">{`Invoke-RestMethod -Method Post -Uri "${base}/api/v1/cards" \`
  -Headers @{ Authorization = "Bearer ${fresh.token}" } \`
  -ContentType "application/json" \`
  -Body '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'`}</pre>
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
              <span className="muted small">
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
            { name, canComplete },
            {
              onSuccess: (r) => {
                setFresh(r);
                setName('');
                setCanComplete(false);
              },
              onError: (err) => setError(errorMessage(err)),
            },
          );
        }}
      >
        <label className="field">
          <span className="field-label">New token for</span>
          <input className="input" placeholder="Uptime Kuma" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={canComplete} onChange={(e) => setCanComplete(e.target.checked)} />
          <span>Recoveries may mark the ticket done (otherwise they only add a note)</span>
        </label>
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
          message="Anything using this token stops being able to open tickets."
          danger
          confirmLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
        />
      )}
    </section>
  );
}
