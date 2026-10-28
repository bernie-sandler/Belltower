// Settings (/settings): general options, the submit page and its request types, automation
// tokens, Discord notifications, and password/version.

import { DEFAULT_TICKET_FORMAT, type SettingsResponse } from '@tt/shared';
import { Bell, Bot, Copy, Globe, KeyRound, Lock, RefreshCw, Settings as SettingsIcon, Send } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { sortedColumns, useBoard } from '../../api/board';
import { useSetBlockedColumn } from '../../api/columns';
import { useConfig } from '../../api/config';
import { errorMessage } from '../../api/errors';
import { qk } from '../../api/keys';
import {
  useNewSubmitLink,
  useSaveDiscord,
  useSaveGeneral,
  useSaveSubmit,
  useSendDigestNow,
  useSettings,
  useTestDiscord,
} from '../../api/settings';
import { copyText } from '../../lib/clipboard';
import { formatDateTime, todayLocal, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { useShell } from '../shell/ShellContext';
import { RequestTypesEditor } from './RequestTypesEditor';
import { TokensSection } from './TokensSection';

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="settings-block">
      <h3 className="card-section-title">
        {icon} {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <LoadingScreen />;
  if (!settings.data) return <ErrorScreen title="Can't load settings" message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  return (
    <div className="list-page settings-page">
      <h2 className="list-page-title">
        <SettingsIcon size={20} aria-hidden /> Settings
      </h2>
      <GeneralSection s={s} />
      <SubmitSection s={s} />
      <TokensSection />
      <DiscordSection s={s} />
      <AccountSection />
    </div>
  );
}

/** "{YY}{MM}{DD}-{N}" on 2026-10-28 → "261028-1". */
function previewTicketNo(format: string): string {
  const [yyyy, mm, dd] = todayLocal().split('-') as [string, string, string];
  return format
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{N\}/g, '1');
}

function GeneralSection({ s }: { s: SettingsResponse }) {
  const ids = useId();
  const { data: board } = useBoard();
  const save = useSaveGeneral();
  const setBlocked = useSetBlockedColumn();
  const qc = useQueryClient();
  const [ticketFormat, setTicketFormat] = useState(s.general.ticketFormat);
  const [appUrl, setAppUrl] = useState(s.general.appUrl);
  const [claudeModel, setClaudeModel] = useState(s.general.claudeModel);
  const [error, setError] = useState<string | null>(null);
  const dirty = ticketFormat !== s.general.ticketFormat || appUrl !== s.general.appUrl || claudeModel !== s.general.claudeModel;
  const columns = board ? sortedColumns(board.columns).filter((c) => c.role === null) : [];

  return (
    <Section icon={<SettingsIcon size={16} aria-hidden />} title="General">
      <label className="field">
        <span className="field-label">Ticket number format</span>
        <input className="input input-mono" value={ticketFormat} onChange={(e) => setTicketFormat(e.target.value)} spellCheck={false} />
        <span className="field-help">
          {'{YY} {YYYY} {MM} {DD}'} for the date, {'{N}'} (last) for the day’s counter. Next ticket would be{' '}
          <code>{previewTicketNo(ticketFormat)}</code>. Existing numbers never change. Default: <code>{DEFAULT_TICKET_FORMAT}</code>
        </span>
      </label>
      <label className="field">
        <span className="field-label">This app’s address</span>
        <input
          className="input"
          type="url"
          placeholder="https://tower.example.com"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
        />
        <span className="field-help">Used for links in Discord messages and to show the submit page’s full address.</span>
      </label>
      {s.general.claudeEnabled && (
        <label className="field">
          <span className="field-label">Claude model</span>
          <input
            className="input input-mono"
            placeholder={s.general.claudeModelFromEnv ?? ''}
            value={claudeModel}
            onChange={(e) => setClaudeModel(e.target.value)}
            spellCheck={false}
          />
          <span className="field-help">Leave empty to use {s.general.claudeModelFromEnv} (ANTHROPIC_MODEL).</span>
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate(
              { ticketFormat, appUrl, claudeModel },
              { onSuccess: () => toast('Saved', { kind: 'success', durationMs: 2000 }), onError: (err) => setError(errorMessage(err)) },
            );
          }}
        >
          Save
        </button>
      </div>

      <label className="field-inline settings-inline">
        <span className="field-inline-label" id={`${ids}-blocked`}>
          Blocked cards go to
        </span>
        <select
          className="input select"
          aria-labelledby={`${ids}-blocked`}
          value={s.blockedColumnId ?? ''}
          onChange={(e) =>
            setBlocked.mutate(e.target.value ? Number(e.target.value) : null, {
              onSuccess: () => void qc.invalidateQueries({ queryKey: qk.settings }),
            })
          }
        >
          <option value="">Don’t move them</option>
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}

function SubmitSection({ s }: { s: SettingsResponse }) {
  const { data: board } = useBoard();
  const save = useSaveSubmit();
  const newLink = useNewSubmitLink();
  const [enabled, setEnabled] = useState(s.submit.enabled);
  const [columnId, setColumnId] = useState<number | null>(s.submit.columnId);
  const [pageTitle, setPageTitle] = useState(s.submit.pageTitle);
  const [intro, setIntro] = useState(s.submit.intro);
  const [confirmNew, setConfirmNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setEnabled(s.submit.enabled), [s.submit.enabled]);

  const base = s.general.appUrl || window.location.origin;
  const link = s.submit.key ? `${base}/submit/${s.submit.key}` : null;
  const dirty =
    enabled !== s.submit.enabled || columnId !== s.submit.columnId || pageTitle !== s.submit.pageTitle || intro !== s.submit.intro;
  const triage = board?.columns.find((c) => c.role === 'triage');

  return (
    <Section icon={<Globe size={16} aria-hidden />} title="Submit page">
      <p className="muted">
        A page where people without your password (family, friends, players) can file a ticket. Anyone with the link can use
        it, and nothing else: they only see the form and the new ticket’s number.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Turn on the submit page</span>
      </label>
      {link && s.submit.enabled && (
        <div className="settings-link">
          <code className="settings-link-url">{link}</code>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void copyText(link).then((ok) => toast(ok ? 'Link copied' : 'Couldn’t copy; select it instead', { kind: ok ? 'success' : 'warning' }))}
          >
            <Copy size={14} aria-hidden /> Copy
          </button>
          <button type="button" className="btn btn-sm btn-subtle" onClick={() => setConfirmNew(true)}>
            <RefreshCw size={14} aria-hidden /> New link
          </button>
        </div>
      )}
      <div className="field-row">
        <label className="field-inline">
          <span className="field-inline-label">Tickets go to</span>
          <select className="input select" value={columnId ?? ''} onChange={(e) => setColumnId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{triage ? `${triage.name} (default)` : 'Triage'}</option>
            {(board ? sortedColumns(board.columns) : [])
              .filter((c) => c.id !== triage?.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Page title</span>
        <input className="input" maxLength={80} value={pageTitle} onChange={(e) => setPageTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Introduction</span>
        <textarea className="input" rows={2} maxLength={1000} value={intro} onChange={(e) => setIntro(e.target.value)} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || save.isPending || !pageTitle.trim()}
          onClick={() => {
            setError(null);
            save.mutate(
              { enabled, columnId, pageTitle, intro },
              { onSuccess: () => toast('Saved', { kind: 'success', durationMs: 2000 }), onError: (err) => setError(errorMessage(err)) },
            );
          }}
        >
          Save
        </button>
      </div>

      <RequestTypesEditor />

      {confirmNew && (
        <ConfirmDialog
          title="Make a new link?"
          message="The current link stops working straight away. You’ll need to share the new one."
          confirmLabel="New link"
          busy={newLink.isPending}
          onCancel={() => setConfirmNew(false)}
          onConfirm={() =>
            newLink.mutate(undefined, {
              onSuccess: () => {
                setConfirmNew(false);
                toast('New link made; the old one no longer works', { kind: 'success' });
              },
            })
          }
        />
      )}
    </Section>
  );
}

const EVENT_LABELS: [keyof SettingsResponse['discord']['events'], string][] = [
  ['external', 'New tickets from the submit page or automation'],
  ['critical', 'Urgent cards: created urgent, or raised to urgent later'],
  ['blocked', 'A card gets blocked'],
  ['digest', 'Daily summary of overdue and due-today cards'],
];

function DiscordSection({ s }: { s: SettingsResponse }) {
  const now = useNow();
  const save = useSaveDiscord();
  const test = useTestDiscord();
  const digestNow = useSendDigestNow();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [alertPriority, setAlertPriority] = useState(s.discord.alertPriority);
  const [alertSeverity, setAlertSeverity] = useState(s.discord.alertSeverity);
  const [events, setEvents] = useState(s.discord.events);
  const [digestTime, setDigestTime] = useState(s.discord.digestTime);
  const [error, setError] = useState<string | null>(null);
  const changed =
    webhookUrl.trim() !== '' ||
    digestTime !== s.discord.digestTime ||
    alertPriority !== s.discord.alertPriority ||
    alertSeverity !== s.discord.alertSeverity ||
    EVENT_LABELS.some(([k]) => events[k] !== s.discord.events[k]);

  function submit(url: string | null) {
    setError(null);
    save.mutate(
      { webhookUrl: url, events, digestTime, alertPriority, alertSeverity },
      {
        onSuccess: () => {
          setWebhookUrl('');
          toast(url === '' ? 'Webhook removed' : 'Saved', { kind: 'success', durationMs: 2000 });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  const last = s.discord.lastDelivery;
  return (
    <Section icon={<Bell size={16} aria-hidden />} title="Discord notifications">
      <p className="muted">
        Posts to a Discord channel through a webhook (Channel settings → Integrations → Webhooks → Copy URL). Nothing is sent
        until one is set.
      </p>
      <label className="field">
        <span className="field-label">Webhook URL</span>
        <input
          className="input input-mono"
          type="url"
          autoComplete="off"
          placeholder={s.discord.webhookHint ?? 'https://discord.com/api/webhooks/…'}
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        {s.discord.webhookSet && <span className="field-help">A webhook is saved. Paste a new one to replace it.</span>}
      </label>
      <fieldset className="ticket-fieldset">
        <legend className="field-label">Send a message for</legend>
        {EVENT_LABELS.map(([k, label]) => (
          <label key={k} className="checkbox">
            <input type="checkbox" checked={events[k]} onChange={(e) => setEvents({ ...events, [k]: e.target.checked })} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <div className="field-row">
        <label className="field-inline settings-inline">
          <span className="field-inline-label">Urgent means</span>
          <select className="input select" value={alertPriority} onChange={(e) => setAlertPriority(e.target.value as typeof alertPriority)}>
            <option value="critical">P0</option>
            <option value="high">P0–P1</option>
            <option value="medium">P0–P2</option>
          </select>
        </label>
        <label className="field-inline settings-inline">
          <span className="field-inline-label">or</span>
          <select className="input select" value={alertSeverity} onChange={(e) => setAlertSeverity(e.target.value as typeof alertSeverity)}>
            <option value="blocker">S1</option>
            <option value="major">S1–S2</option>
            <option value="minor">S1–S3</option>
          </select>
        </label>
      </div>
      <label className="field-inline settings-inline">
        <span className="field-inline-label">Daily summary at</span>
        <input className="input" type="time" value={digestTime} onChange={(e) => setDigestTime(e.target.value || '08:00')} />
        <span className="muted small">your time zone; sent within a minute of this time</span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="button" className="btn btn-primary" disabled={!changed || save.isPending} onClick={() => submit(webhookUrl.trim() || null)}>
          Save
        </button>
        <button
          type="button"
          className="btn"
          disabled={!s.discord.webhookSet || test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) => toast(r.ok ? 'Test message sent' : r.message, { kind: r.ok ? 'success' : 'error' }),
              onError: (err) => toast(errorMessage(err), { kind: 'error' }),
            })
          }
        >
          <Send size={14} aria-hidden /> {test.isPending ? 'Sending…' : 'Send test'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!s.discord.webhookSet || digestNow.isPending}
          onClick={() =>
            digestNow.mutate(undefined, {
              onSuccess: (r) => toast(r.ok ? 'Summary sent' : r.message, { kind: r.ok ? 'success' : 'error' }),
              onError: (err) => toast(errorMessage(err), { kind: 'error' }),
            })
          }
        >
          {digestNow.isPending ? 'Sending…' : 'Send summary now'}
        </button>
        {s.discord.webhookSet && (
          <button type="button" className="btn btn-subtle" disabled={save.isPending} onClick={() => submit('')}>
            Remove webhook
          </button>
        )}
      </div>
      {last && (
        <p className={last.ok ? 'muted small' : 'import-warning small'}>
          Last message {last.ok ? 'delivered' : 'failed'} {formatDateTime(last.at, now)}
          {!last.ok && `: ${last.message}`}
        </p>
      )}
    </Section>
  );
}

function AccountSection() {
  const shell = useShell();
  const { data: config } = useConfig();
  return (
    <Section icon={<Lock size={16} aria-hidden />} title="Password and version">
      <div className="editor-actions">
        <button type="button" className="btn" onClick={shell.openSettings}>
          <KeyRound size={14} aria-hidden /> Change password…
        </button>
      </div>
      <p className="muted small">
        <Bot size={12} aria-hidden /> Tower Tracker {config?.appVersion ?? '…'} · time zone {config?.timeZone ?? '…'}
      </p>
    </Section>
  );
}
