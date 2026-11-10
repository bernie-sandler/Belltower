// Account (/account): your own profile and password. Every person has one, admins and members
// alike. Each part is its own section component, so new ones (sign-in methods, personal
// notifications) slot in as further sections.

import type { MeResponse } from '@tt/shared';
import { IdCard, KeyRound, Lock, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useMe, useUpdateMe } from '../../api/me';
import { toast } from '../../lib/toast';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { Section } from '../settings/SettingsPage';
import { useShell } from '../shell/ShellContext';

export function AccountPage() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (!me.data) return <ErrorScreen title="Can't load your account" message={errorMessage(me.error)} onRetry={() => void me.refetch()} />;
  return (
    <div className="list-page settings-page account-page">
      <h2 className="list-page-title">
        <UserRound size={20} aria-hidden /> Account
      </h2>
      <ProfileSection me={me.data} />
      <PasswordSection me={me.data} />
    </div>
  );
}

const ROLE_TEXT: Record<MeResponse['role'], string> = {
  admin: 'Admin: runs this install (people, settings, backups) and does the board work.',
  member: 'Member: does the board work. An admin manages people, settings and backups.',
};

/** Display name and email; the username and role are shown, set by an admin. */
export function ProfileSection({ me }: { me: MeResponse }) {
  const save = useUpdateMe();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [email, setEmail] = useState(me.email ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDisplayName(me.displayName), [me.displayName]);
  useEffect(() => setEmail(me.email ?? ''), [me.email]);
  const dirty = displayName.trim() !== me.displayName || email.trim() !== (me.email ?? '');

  return (
    <Section icon={<IdCard size={16} aria-hidden />} title="Profile">
      <p className="muted">
        Signed in as <strong>{me.username}</strong>
        {me.isOwner ? ' (the owner)' : ''}. {ROLE_TEXT[me.role]}
      </p>
      <label className="field">
        <span className="field-label">Display name</span>
        <input className="input" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
        <span className="field-help">How others see you on cards and in history.</span>
      </label>
      <label className="field">
        <span className="field-label">Email (optional)</span>
        <input className="input" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <span className="field-help">Only admins and you can see it.</span>
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
          disabled={!dirty || !displayName.trim() || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate(
              { displayName: displayName.trim(), email: email.trim() || null },
              { onSuccess: () => toast('Saved', { kind: 'success', durationMs: 2000 }), onError: (err) => setError(errorMessage(err)) },
            );
          }}
        >
          Save
        </button>
      </div>
    </Section>
  );
}

/** Your password (the change itself happens in the password dialog). */
export function PasswordSection({ me }: { me: MeResponse }) {
  const shell = useShell();
  return (
    <Section icon={<Lock size={16} aria-hidden />} title="Password">
      {me.passwordManagedByEnv ? (
        <p className="muted">
          Your password is set with <code>APP_PASSWORD</code> in the container&apos;s environment.
        </p>
      ) : (
        <p className="muted">Changing it signs you out on your other devices.</p>
      )}
      <div className="editor-actions">
        <button type="button" className="btn" onClick={shell.openSettings}>
          <KeyRound size={14} aria-hidden /> Change password…
        </button>
      </div>
    </Section>
  );
}
