// Settings (/settings): general options, people, the submit page and its request types,
// automation tokens, notifications, single sign-on, and the version. Members see only what's theirs to change
// here (appearance); the install's settings are for admins. Your own password and tokens are
// under Account.

import { DEFAULT_TICKET_FORMAT, type SettingsResponse } from '@tt/shared';
import { Bot, Copy, Globe, Info, Palette, RefreshCw, Settings as SettingsIcon, UserRound, Volume2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { sortedColumns, useBoard } from '../../api/board';
import { useSetBlockedColumn } from '../../api/columns';
import { useConfig } from '../../api/config';
import { errorMessage } from '../../api/errors';
import { qk } from '../../api/keys';
import { useIsAdmin } from '../../api/me';
import { useNewSubmitLink, useResetStatusLinks, useSaveGeneral, useSaveSubmit, useSettings } from '../../api/settings';
import { copyText } from '../../lib/clipboard';
import { playSound, setSound, useSound, type SoundChoice } from '../../lib/sound';
import { setTheme, useTheme, type ThemeChoice } from '../../lib/theme';
import { todayLocal } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { RequestTypesEditor } from './RequestTypesEditor';
import { NotificationsSection } from './NotificationsSection';
import { PeopleSection } from './PeopleSection';
import { ResolutionReasonsSection } from './ResolutionReasonsSection';
import { SsoSection } from './SsoSection';
import { TokensSection } from './TokensSection';

export function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
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
  const isAdmin = useIsAdmin();
  if (settings.isPending) return <LoadingScreen />;
  if (!settings.data) return <ErrorScreen title="Can't load settings" message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  return (
    <div className="list-page settings-page">
      <h2 className="list-page-title">
        <SettingsIcon size={20} aria-hidden /> Settings
      </h2>
      <AppearanceSection />
      {isAdmin && <GeneralSection s={s} />}
      {isAdmin && <PeopleSection />}
      {isAdmin && <ResolutionReasonsSection s={s} />}
      {isAdmin && <SubmitSection s={s} />}
      {isAdmin && <TokensSection />}
      {isAdmin && <NotificationsSection s={s} />}
      {isAdmin && <SsoSection />}
      <AboutSection />
    </div>
  );
}

/**
 * Per device (this browser), so a phone can follow the system while the desktop stays dark, and
 * the work laptop can stay quiet while the desktop at home chimes.
 */
function AppearanceSection() {
  const theme = useTheme();
  const sound = useSound();
  const sounds: [SoundChoice, string][] = [
    ['off', 'Off'],
    ['chime', 'Chime'],
    ['ping', 'Ping'],
  ];
  const options: [ThemeChoice, string][] = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  return (
    <Section icon={<Palette size={16} aria-hidden />} title="Appearance">
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {options.map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={theme === value} className="segmented-item" onClick={() => setTheme(value)}>
            {label}
          </button>
        ))}
      </div>
      <p className="field-help">Saved on this device only. System follows your phone or computer’s light/dark setting.</p>
      <span className="field-label sound-label">Sound for new notifications</span>
      <div className="sound-row">
        <div className="segmented" role="radiogroup" aria-label="Sound for new notifications">
          {sounds.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={sound === value}
              className="segmented-item"
              onClick={() => {
                setSound(value);
                playSound(value, true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={sound === 'off'} onClick={() => playSound(sound, true)}>
          <Volume2 size={14} aria-hidden /> Test
        </button>
      </div>
      <p className="field-help">
        Saved on this device only. It plays when the bell gets something new, in one open tab, once you’ve clicked or typed
        on the page (browsers don’t allow sound before that).
      </p>
    </Section>
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
          placeholder="https://belltower.example.com"
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
  const resetStatus = useResetStatusLinks();
  const [enabled, setEnabled] = useState(s.submit.enabled);
  const [columnId, setColumnId] = useState<number | null>(s.submit.columnId);
  const [pageTitle, setPageTitle] = useState(s.submit.pageTitle);
  const [intro, setIntro] = useState(s.submit.intro);
  const [confirmNew, setConfirmNew] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
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
        it, and nothing else: they see the form, and afterwards a status link for their own ticket that shows whether it’s
        received, being worked on or done.
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

      {s.submit.key && (
        <div className="settings-subblock">
          <p className="muted small">
            <strong>Status links.</strong> After sending, people get a link to check on their ticket. To send one for any
            ticket yourself, open the card and press Status link. They only work while the submit page is on.
          </p>
          <button type="button" className="btn btn-sm btn-subtle" onClick={() => setConfirmReset(true)}>
            <RefreshCw size={14} aria-hidden /> Reset status links
          </button>
        </div>
      )}

      <RequestTypesEditor />

      {confirmReset && (
        <ConfirmDialog
          title="Reset every status link?"
          message="Every status link handed out so far stops working. New tickets get new links, and Status link on a card copies a fresh one."
          confirmLabel="Reset links"
          busy={resetStatus.isPending}
          onCancel={() => setConfirmReset(false)}
          onConfirm={() =>
            resetStatus.mutate(undefined, {
              onSuccess: () => {
                setConfirmReset(false);
                toast('Status links reset; the old ones no longer work', { kind: 'success' });
              },
            })
          }
        />
      )}
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

/** The version and how this install is set up; your password and tokens are under Account. */
function AboutSection() {
  const { data: config } = useConfig();
  const uploadMb = config ? Math.round(config.maxUploadBytes / (1024 * 1024)) : null;
  return (
    <Section icon={<Info size={16} aria-hidden />} title="About">
      <p className="muted small">
        <Bot size={12} aria-hidden /> Belltower {config?.appVersion ?? '…'} · time zone {config?.timeZone ?? '…'} · uploads up to{' '}
        {uploadMb ?? '…'} MB
      </p>
      <p className="muted small">
        <UserRound size={12} aria-hidden /> Your password, profile and API tokens are under <Link to="/account">Account</Link>.
      </p>
    </Section>
  );
}
