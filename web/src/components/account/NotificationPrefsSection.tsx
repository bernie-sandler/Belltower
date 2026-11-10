// Account → Notifications: what reaches you and where. The bell in the top bar always works;
// Discord and ntfy ride on the channels an admin set up for the install (Settings → Notifications),
// so each says when the install doesn't have one yet. The sound is per device, under Settings →
// Appearance.

import {
  DiscordUserId,
  NOTIFICATION_TYPES,
  NtfyTopic,
  PERSONAL_CHANNELS,
  type NotificationType,
  type NotifyPrefs,
  type PersonalChannel,
  type PersonalNotifySettings,
  type PersonalTestResult,
} from '@tt/shared';
import { BellRing, Dices, Send } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/errors';
import { usePersonalNotify, useSavePersonalNotify, useSendPersonalTest } from '../../api/notifications';
import { toast } from '../../lib/toast';
import { Spinner } from '../common/Status';
import { Section } from '../settings/SettingsPage';

const EVENT_LABELS: Record<NotificationType, string> = {
  assigned: 'Assigned to you',
  mentioned: 'You’re @mentioned',
  watching: 'Cards you watch',
  new_unassigned: 'New tickets nobody has',
};

const EVENT_HINTS: Record<NotificationType, string> = {
  assigned: '',
  mentioned: 'in a note',
  watching: 'a new note, a move, a new assignee',
  new_unassigned: 'from the submit page or a tool',
};

const CHANNEL_LABELS: Record<PersonalChannel, string> = { inApp: 'In the app', discord: 'Discord', ntfy: 'ntfy' };
const CHANNEL_SHORT: Record<PersonalChannel, string> = { inApp: 'In app', discord: 'Discord', ntfy: 'ntfy' };

/** 20 random characters (100 bits) from a-z and 2-7, so the topic can't be guessed. */
export function randomTopic(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `belltower-${Array.from(bytes, (b) => alphabet[b % 32]).join('')}`;
}

export function NotificationPrefsSection() {
  const query = usePersonalNotify();
  return (
    <Section icon={<BellRing size={16} aria-hidden />} title="Notifications">
      {query.data ? (
        <PrefsForm settings={query.data} />
      ) : query.isPending ? (
        <Spinner label="Loading…" />
      ) : (
        <p className="form-error" role="alert">
          {errorMessage(query.error)}
        </p>
      )}
    </Section>
  );
}

function PrefsForm({ settings }: { settings: PersonalNotifySettings }) {
  const ids = useId();
  const save = useSavePersonalNotify();
  const test = useSendPersonalTest();
  const [prefs, setPrefs] = useState<NotifyPrefs>(settings.prefs);
  const [discordId, setDiscordId] = useState(settings.discordUserId ?? '');
  const [topic, setTopic] = useState(settings.ntfyTopic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PersonalTestResult | null>(null);
  useEffect(() => {
    setPrefs(settings.prefs);
    setDiscordId(settings.discordUserId ?? '');
    setTopic(settings.ntfyTopic ?? '');
  }, [settings]);

  const { install } = settings;
  const dirty =
    JSON.stringify(prefs) !== JSON.stringify(settings.prefs) ||
    discordId.trim() !== (settings.discordUserId ?? '') ||
    topic.trim() !== (settings.ntfyTopic ?? '');
  const discordError = discordId.trim() && !DiscordUserId.safeParse(discordId).success ? 'A Discord user ID is 17 to 20 digits.' : null;
  const topicError = topic.trim() && !NtfyTopic.safeParse(topic).success ? 'Start it with belltower-, then up to 54 letters, digits, dashes and underscores.' : null;
  const canTest = !dirty && (settings.discordUserId !== null || settings.ntfyTopic !== null);
  /** Ticked somewhere, but nowhere to send it: say so, or nothing would arrive and nobody would know why. */
  const ticked = (c: PersonalChannel) => NOTIFICATION_TYPES.some((t) => prefs[t][c]);
  const nowhere = [
    ticked('discord') && !discordId.trim() && 'Discord is ticked, but there’s no Discord user ID below, so nothing goes there yet.',
    ticked('ntfy') && !topic.trim() && 'ntfy is ticked, but there’s no topic below, so nothing goes there yet.',
  ].filter((w): w is string => Boolean(w));

  /** Why a channel's boxes are off (null when they can be used). */
  const unavailable: Record<PersonalChannel, string | null> = {
    inApp: null,
    discord: install.discord ? null : 'This install has no Discord channel yet.',
    ntfy: install.ntfy ? null : 'This install has no ntfy channel yet.',
  };

  function toggle(type: NotificationType, channel: PersonalChannel, on: boolean) {
    setPrefs((p) => ({ ...p, [type]: { ...p[type], [channel]: on } }));
  }

  function submit() {
    setError(null);
    setResults(null);
    save.mutate(
      { prefs, discordUserId: discordId.trim() || null, ntfyTopic: topic.trim() || null },
      { onSuccess: () => toast('Saved', { kind: 'success', durationMs: 2000 }), onError: (err) => setError(errorMessage(err)) },
    );
  }

  return (
    <>
      <p className="muted">
        Choose what reaches you, and where. The bell in the top bar shows what’s new; you watch a card when you make it,
        are assigned it, are mentioned on it or write a note on it (or press Watch on it). You’re never told about
        what you did yourself.
      </p>

      <div className="notify-matrix-wrap">
        <table className="notify-matrix">
          <caption className="visually-hidden">What notifies you, and where</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              {PERSONAL_CHANNELS.map((c) => (
                <th key={c} scope="col">
                  {CHANNEL_SHORT[c]}
                  {unavailable[c] && <span className="notify-matrix-off">not set up</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_TYPES.map((type) => (
              <tr key={type}>
                <th scope="row">
                  {EVENT_LABELS[type]}
                  {EVENT_HINTS[type] && <span className="notify-matrix-hint">{EVENT_HINTS[type]}</span>}
                </th>
                {PERSONAL_CHANNELS.map((c) => (
                  <td key={c}>
                    <input
                      type="checkbox"
                      aria-label={`${CHANNEL_LABELS[c]}: ${EVENT_LABELS[type]}`}
                      checked={prefs[type][c]}
                      disabled={unavailable[c] !== null && !prefs[type][c]}
                      onChange={(e) => toggle(type, c, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nowhere.map((w) => (
        <p key={w} className="import-warning small" role="status">
          {w}
        </p>
      ))}
      {(unavailable.discord || unavailable.ntfy) && (
        <p className="field-help">
          {[unavailable.discord, unavailable.ntfy].filter(Boolean).join(' ')} Personal messages go out through the install’s own
          channels, so an admin sets {unavailable.discord && unavailable.ntfy ? 'them' : 'it'} up first under Settings → Notifications.
        </p>
      )}

      <div className="field">
        <label className="field-label" htmlFor={`${ids}-discord`}>
          Your Discord user ID
        </label>
        <input
          id={`${ids}-discord`}
          className="input input-mono"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={20}
          placeholder="123456789012345678"
          value={discordId}
          onChange={(e) => setDiscordId(e.target.value)}
          aria-invalid={discordError ? true : undefined}
          aria-describedby={`${ids}-discord-help`}
        />
        <span className="field-help" id={`${ids}-discord-help`}>
          {discordError ?? (
            <>
              In Discord, turn on Settings → Advanced → Developer Mode, then right-click your name and choose Copy User ID.
              Messages go to the install’s shared Discord channel and mention only you there (a webhook can’t send direct
              messages).
            </>
          )}
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${ids}-topic`}>
          Your ntfy topic
        </label>
        <span className="topic-row">
          <input
            id={`${ids}-topic`}
            className="input input-mono"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            placeholder="belltower-…"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-invalid={topicError ? true : undefined}
            aria-describedby={`${ids}-topic-help`}
          />
          <button type="button" className="btn" onClick={() => setTopic(randomTopic())}>
            <Dices size={14} aria-hidden /> Random topic
          </button>
        </span>
        <span className="field-help" id={`${ids}-topic-help`}>
          {topicError ?? (
            <>
              It starts with belltower-. Subscribe to it in the ntfy app, on the same server as the install’s ntfy channel.
              Anyone who knows a topic’s name can read it, so treat it like a password: a random one is best. If the server
              needs access tokens, an admin gives the install’s token write access to belltower-* topics.
            </>
          )}
        </span>
      </div>

      <p className="field-help">
        The sound for new notifications is set for each device under <Link to="/settings">Settings → Appearance</Link>.
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || !!discordError || !!topicError || save.isPending} onClick={submit}>
          Save
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canTest || test.isPending}
          title={canTest ? undefined : dirty ? 'Save first' : 'Fill in a Discord user ID or an ntfy topic first'}
          onClick={() => {
            setError(null);
            setResults(null);
            test.mutate(undefined, { onSuccess: setResults, onError: (err) => setError(errorMessage(err)) });
          }}
        >
          <Send size={14} aria-hidden /> {test.isPending ? 'Sending…' : 'Send me a test'}
        </button>
      </div>
      {results && (
        <ul className="notify-test-results" aria-live="polite">
          {(['discord', 'ntfy'] as const).map((c) => {
            const r = results[c];
            return r ? (
              <li key={c} className={r.ok ? 'muted small' : 'import-warning small'}>
                {CHANNEL_LABELS[c]}: {r.ok ? 'sent' : r.message}
              </li>
            ) : null;
          })}
        </ul>
      )}
    </>
  );
}
