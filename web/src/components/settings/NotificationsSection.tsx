// Settings → Notifications: what counts as urgent and when the daily summary goes out (shared), then
// one panel per channel (Discord, ntfy, Gotify, webhook), each with its own address, secret and
// events. Saved addresses and secrets never come back from the server, only hints.

import type { NotifyChannelInfo, SettingsResponse } from '@tt/shared';
import { Bell, Send } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/errors';
import { useChannelAction, useSaveAlerts, useSaveChannel, useSaveDiscord, type AnyChannel } from '../../api/settings';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';

type Events = NotifyChannelInfo['events'];

const EVENT_LABELS: [keyof Events, string][] = [
  ['external', 'New tickets from the submit page or automation'],
  ['critical', 'Urgent cards: created urgent, or raised to urgent later'],
  ['blocked', 'A card gets blocked'],
  ['digest', 'Daily summary of overdue and due-today cards'],
];

interface ChannelDef {
  id: AnyChannel;
  name: string;
  intro: ReactNode;
  urlLabel: string;
  urlPlaceholder: string;
  /** No secret field for Discord: its webhook address is the secret. */
  secret?: { label: string; help: string; required?: boolean };
}

const CHANNELS: ChannelDef[] = [
  {
    id: 'discord',
    name: 'Discord',
    intro: 'Posts to a Discord channel through a webhook (Channel settings → Integrations → Webhooks → Copy URL).',
    urlLabel: 'Webhook URL',
    urlPlaceholder: 'https://discord.com/api/webhooks/…',
  },
  {
    id: 'ntfy',
    name: 'ntfy',
    intro: 'Push notifications to your phone through ntfy.sh or your own ntfy server. Urgent cards arrive with top priority.',
    urlLabel: 'Topic address',
    urlPlaceholder: 'https://ntfy.sh/your-long-random-topic',
    secret: { label: 'Access token', help: 'Only if the topic is protected (tk_…).' },
  },
  {
    id: 'gotify',
    name: 'Gotify',
    intro: 'Push notifications through your Gotify server. Create an application in Gotify and paste its token.',
    urlLabel: 'Server address',
    urlPlaceholder: 'https://gotify.example.com',
    secret: { label: 'App token', help: 'From Gotify → Apps.', required: true },
  },
  {
    id: 'webhook',
    name: 'Webhook',
    intro: 'Posts a JSON message to any address: Home Assistant, n8n, your own script. See docs/NOTIFICATIONS.md for the format.',
    urlLabel: 'Address',
    urlPlaceholder: 'https://homeassistant.lan:8123/api/webhook/belltower',
    secret: { label: 'Signing secret', help: 'Adds an X-Belltower-Signature header so the receiver can check it came from here.' },
  },
];

export function NotificationsSection({ s }: { s: SettingsResponse }) {
  return (
    <section className="settings-block">
      <h3 className="card-section-title">
        <Bell size={16} aria-hidden /> Notifications
      </h3>
      <p className="muted">
        Tell Discord, your phone or another system when something needs you. Nothing is sent through a channel until it’s set up,
        and each channel picks what it hears about.
      </p>
      <AlertsForm s={s} />
      {CHANNELS.map((def) => (
        <ChannelPanel key={def.id} def={def} info={infoOf(s, def.id)} />
      ))}
    </section>
  );
}

function infoOf(s: SettingsResponse, id: AnyChannel): NotifyChannelInfo {
  if (id !== 'discord') return s.notify.channels[id];
  const d = s.discord;
  return { set: d.webhookSet, hint: d.webhookHint, secretSet: false, events: d.events, lastDelivery: d.lastDelivery };
}

/** Shared by every channel. */
function AlertsForm({ s }: { s: SettingsResponse }) {
  const save = useSaveAlerts();
  const a = s.notify.alerts;
  const [alertPriority, setAlertPriority] = useState(a.alertPriority);
  const [alertSeverity, setAlertSeverity] = useState(a.alertSeverity);
  const [digestTime, setDigestTime] = useState(a.digestTime);
  const changed = alertPriority !== a.alertPriority || alertSeverity !== a.alertSeverity || digestTime !== a.digestTime;
  return (
    <div className="notify-alerts">
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
      {changed && (
        <div className="editor-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { alertPriority, alertSeverity, digestTime },
                {
                  onSuccess: () => toast('Saved', { kind: 'success', durationMs: 2000 }),
                  onError: (err) => toast(errorMessage(err), { kind: 'error' }),
                },
              )
            }
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function ChannelPanel({ def, info }: { def: ChannelDef; info: NotifyChannelInfo }) {
  const ids = useId();
  const now = useNow();
  const [open, setOpen] = useState(info.set);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState(info.events);
  const [error, setError] = useState<string | null>(null);
  // Both hooks always run (hooks can't be conditional); only the one for this channel is used.
  const saveDiscord = useSaveDiscord();
  const saveOther = useSaveChannel(def.id === 'discord' ? 'ntfy' : def.id);
  const save = def.id === 'discord' ? saveDiscord : saveOther;
  const test = useChannelAction(def.id, 'test');
  const digestNow = useChannelAction(def.id, 'digest-now');
  const changed = url.trim() !== '' || secret.trim() !== '' || EVENT_LABELS.some(([k]) => events[k] !== info.events[k]);
  const hasSomething = info.hint !== null || info.secretSet;

  function submit(remove: boolean) {
    setError(null);
    const done = {
      onSuccess: () => {
        setUrl('');
        setSecret('');
        toast(remove ? `${def.name} removed` : 'Saved', { kind: 'success', durationMs: 2000 });
      },
      onError: (err: unknown) => setError(errorMessage(err)),
    };
    if (def.id === 'discord') {
      saveDiscord.mutate({ webhookUrl: remove ? '' : url.trim() || null, events }, done);
    } else {
      saveOther.mutate({ url: remove ? '' : url.trim() || null, secret: remove ? '' : secret.trim() || null, events }, done);
    }
  }

  const run = (action: typeof test, ok: string) =>
    action.mutate(undefined, {
      onSuccess: (r) => toast(r.ok ? ok : r.message, { kind: r.ok ? 'success' : 'error' }),
      onError: (err) => toast(errorMessage(err), { kind: 'error' }),
    });

  const last = info.lastDelivery;
  return (
    <details className="notify-channel" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <strong>{def.name}</strong>{' '}
        <span className="muted small">
          {info.set ? (last && !last.ok ? '· on, last message failed' : '· on') : hasSomething ? '· not finished' : '· off'}
        </span>
      </summary>
      <div className="notify-channel-body">
        <p className="muted small">{def.intro}</p>
        <label className="field">
          <span className="field-label">{def.urlLabel}</span>
          <input
            className="input input-mono"
            type="url"
            autoComplete="off"
            placeholder={info.hint ?? def.urlPlaceholder}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {info.hint && <span className="field-help">An address is saved. Paste a new one to replace it.</span>}
        </label>
        {def.secret && (
          <label className="field">
            <span className="field-label">
              {def.secret.label}
              {def.secret.required ? '' : ' (optional)'}
            </span>
            <input
              className="input input-mono"
              type="password"
              autoComplete="off"
              placeholder={info.secretSet ? 'Saved (type to replace)' : ''}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              aria-describedby={`${ids}-secret-help`}
            />
            <span className="field-help" id={`${ids}-secret-help`}>
              {def.secret.help} Changing the address to another server forgets a saved one.
            </span>
          </label>
        )}
        <fieldset className="ticket-fieldset">
          <legend className="field-label">Send a message for</legend>
          {EVENT_LABELS.map(([k, label]) => (
            <label key={k} className="checkbox">
              <input type="checkbox" checked={events[k]} onChange={(e) => setEvents({ ...events, [k]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-actions">
          <button type="button" className="btn btn-primary" disabled={!changed || save.isPending} onClick={() => submit(false)}>
            Save
          </button>
          <button type="button" className="btn" disabled={!info.set || test.isPending} onClick={() => run(test, 'Test message sent')}>
            <Send size={14} aria-hidden /> {test.isPending ? 'Sending…' : 'Send test'}
          </button>
          <button type="button" className="btn" disabled={!info.set || digestNow.isPending} onClick={() => run(digestNow, 'Summary sent')}>
            {digestNow.isPending ? 'Sending…' : 'Send summary now'}
          </button>
          {hasSomething && (
            <button type="button" className="btn btn-subtle" disabled={save.isPending} onClick={() => submit(true)}>
              Remove {def.name}
            </button>
          )}
        </div>
        {last && (
          <p className={last.ok ? 'muted small' : 'import-warning small'}>
            Last message {last.ok ? 'delivered' : 'failed'} {formatDateTime(last.at, now)}
            {!last.ok && `: ${last.message}`}
          </p>
        )}
      </div>
    </details>
  );
}
