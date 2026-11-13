// Settings → People (admins): everyone who can sign in. Add someone with a temporary password,
// change their display name or role, restrict a member to some tags, deactivate or re-enable them,
// and reset their password.
// Controls that could only fail are hidden: the owner stays an active admin, nobody deactivates
// themselves or resets their own password here (that's under Account), and the last active admin
// stays one.

import { CreateUserBody, PASSWORD_MIN_LENGTH, type MeResponse, type UserInfo, type UserRole } from '@tt/shared';
import { Dices, Eye, EyeOff, KeyRound, UserCheck, UserPlus, Users, UserX } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useBoard } from '../../api/board';
import { useTeams } from '../../api/config';
import { errorMessage } from '../../api/errors';
import { useMe, useUsers } from '../../api/me';
import { peopleErrorMessage, useCreateUser, useUpdateUser } from '../../api/people';
import { cls } from '../../lib/cls';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Spinner } from '../common/Status';
import { Section } from './SettingsPage';

const ROLE_LABEL: Record<UserRole, string> = { admin: 'Admin', member: 'Member' };

export function PeopleSection() {
  const { data: users, error, isPending, refetch } = useUsers();
  const { data: me } = useMe();
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const activeAdmins = users?.filter((u) => u.role === 'admin' && !u.disabled).length ?? 0;
  const teams = useTeams();
  const active = users?.filter((u) => !u.disabled).length ?? 0;

  return (
    <Section icon={<Users size={16} aria-hidden />} title="People">
      <p className="muted">
        Admins run this install: people, settings and backups. Members do the board work and manage their own account and
        tokens. People are deactivated rather than deleted, so the history keeps their names.
      </p>
      {!teams && active > 1 && (
        <p className="notice people-teams-hint" role="note">
          Turn on Teams in General to assign cards to people
        </p>
      )}
      {isPending && <Spinner label="Loading people…" />}
      {!isPending && !users && (
        <p className="muted">
          {errorMessage(error)}{' '}
          <button type="button" className="link-btn" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {users && (
        <ul className="people-list" aria-label="People">
          {users.map((u) => (
            <PersonRow
              key={u.id}
              user={u}
              me={me}
              lastAdmin={u.role === 'admin' && !u.disabled && activeAdmins <= 1}
              editing={editing === u.id}
              onEdit={() => setEditing(u.id)}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <AddPersonForm onDone={() => setAdding(false)} />
      ) : (
        <div className="editor-actions">
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <UserPlus size={14} aria-hidden /> Add person
          </button>
        </div>
      )}
    </Section>
  );
}

function PersonRow({
  user,
  me,
  lastAdmin,
  editing,
  onEdit,
  onDone,
}: {
  user: UserInfo;
  me: MeResponse | undefined;
  lastAdmin: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const self = me?.id === user.id;
  return (
    <li className={cls('person-row', user.disabled && 'is-disabled')}>
      <div className="person-head">
        <div className="person-main">
          <span className="person-name">{user.displayName}</span>
          <span className="muted small">
            {user.username} · {user.hasPassword ? 'password set' : 'no password (signs in with single sign-on)'}
          </span>
        </div>
        <span className="person-tags">
          <span className="tag">{ROLE_LABEL[user.role]}</span>
          {user.isOwner && <span className="tag tag-success">Owner</span>}
          {self && <span className="tag">You</span>}
          {user.tagScope !== null && <RestrictionTag tagScope={user.tagScope} />}
          {user.disabled && <span className="tag tag-off">Deactivated</span>}
        </span>
        {!editing && (
          <button type="button" className="btn btn-sm" aria-label={`Edit ${user.displayName}`} onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      {editing && <PersonEditor user={user} self={self} lastAdmin={lastAdmin} onDone={onDone} />}
    </li>
  );
}

/** "Only: A, B" for a tag-restricted member ("Sees nothing" when none of their tags exist any more). */
function RestrictionTag({ tagScope }: { tagScope: number[] }) {
  const labels = useBoard().data?.labels ?? [];
  const names = tagScope.map((id) => labels.find((l) => l.id === id)?.name).filter((n): n is string => n !== undefined);
  return (
    <span className="tag tag-off" title="Sees only tickets with one of these tags">
      {tagScope.length ? `Only: ${names.join(', ')}` : 'Sees nothing (no tags)'}
    </span>
  );
}

function PersonEditor({ user, self, lastAdmin, onDone }: { user: UserInfo; self: boolean; lastAdmin: boolean; onDone: () => void }) {
  const ids = useId();
  const update = useUpdateUser();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<UserRole>(user.role);
  const [restrict, setRestrict] = useState(user.tagScope !== null);
  const [tags, setTags] = useState<number[]>(user.tagScope ?? []);
  const labels = useBoard().data?.labels ?? [];
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // What can't succeed isn't offered (the server refuses it anyway).
  const roleLocked = user.isOwner || lastAdmin;
  const canDeactivate = !user.disabled && !user.isOwner && !self && !lastAdmin;
  const canReset = !user.isOwner && !self;
  // Tag restriction: members only (admins and the owner always see every ticket).
  const canRestrict = role === 'member' && !user.isOwner;
  const tagScope = canRestrict && restrict ? tags : null;
  const scopeChanged = canRestrict && JSON.stringify(tagScope) !== JSON.stringify(user.tagScope);
  const dirty = displayName.trim() !== user.displayName || role !== user.role || scopeChanged;

  function run(patch: { displayName?: string; role?: UserRole; disabled?: boolean; password?: string; tagScope?: number[] | null }, done: (u: UserInfo) => void) {
    setError(null);
    update.mutate({ id: user.id, ...patch }, { onSuccess: done, onError: (err) => setError(peopleErrorMessage(err)) });
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || !displayName.trim()) return;
    run(
      {
        ...(displayName.trim() !== user.displayName ? { displayName: displayName.trim() } : {}),
        ...(role !== user.role ? { role } : {}),
        ...(scopeChanged ? { tagScope } : {}),
      },
      () => {
        toast('Saved', { kind: 'success', durationMs: 2000 });
        onDone();
      },
    );
  }

  return (
    <div className="person-editor">
      <form className="form-stack" onSubmit={save} noValidate>
        <label className="field">
          <span className="field-label">Display name</span>
          <input className="input" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
        </label>
        {roleLocked ? (
          <p className="muted small">
            {user.isOwner ? 'The owner is always an admin.' : 'The only active admin stays an admin; make someone else an admin first.'}
          </p>
        ) : (
          <fieldset className="ticket-fieldset">
            <legend className="field-label">Role</legend>
            {(['member', 'admin'] as const).map((r) => (
              <label key={r} className="checkbox">
                <input type="radio" name={`${ids}-role`} checked={role === r} onChange={() => setRole(r)} />
                <span>{r === 'admin' ? 'Admin: people, settings and backups, plus the board work' : 'Member: the board work'}</span>
              </label>
            ))}
            {self && role === 'member' && user.role === 'admin' && (
              <span className="field-help is-error">You’ll lose access to People and the install’s settings straight away.</span>
            )}
          </fieldset>
        )}
        {canRestrict && (
          <fieldset className="ticket-fieldset">
            <legend className="field-label">Tickets they see</legend>
            <label className="checkbox">
              <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
              <span>Restrict to tags</span>
            </label>
            {restrict && (
              <>
                <div className="label-picker" role="group" aria-label="Tags they see">
                  {labels.map((l) => (
                    <label key={l.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={tags.includes(l.id)}
                        onChange={() => setTags((ids) => (ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id]))}
                      />
                      <span>{l.name}</span>
                    </label>
                  ))}
                </div>
                <span className="field-help">
                  They see only tickets with at least one of these tags; tickets without tags are hidden from them. They
                  can’t change tags or columns. If all of these tags are deleted, they see nothing.
                </span>
              </>
            )}
          </fieldset>
        )}
        <div className="editor-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || !displayName.trim() || update.isPending}>
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={onDone}>
            Close
          </button>
        </div>
      </form>

      {canReset && (
        <form
          className="form-stack person-reset"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length < PASSWORD_MIN_LENGTH) return;
            run({ password }, () => {
              setPassword('');
              toast(`Password reset. ${user.displayName} was signed out everywhere; hand them the new one.`, { kind: 'success' });
            });
          }}
        >
          <TempPasswordField
            label={user.hasPassword ? 'Reset password to' : 'Set a password'}
            help={`At least ${PASSWORD_MIN_LENGTH} characters. Signs them out everywhere; they can change it under Account.`}
            value={password}
            onChange={setPassword}
          />
          <div className="editor-actions">
            <button type="submit" className="btn btn-sm" disabled={password.length < PASSWORD_MIN_LENGTH || update.isPending}>
              <KeyRound size={14} aria-hidden /> {user.hasPassword ? 'Reset password' : 'Set password'}
            </button>
          </div>
        </form>
      )}
      {user.isOwner && !self && <p className="muted small">Only the owner changes the owner’s password, under Account.</p>}
      {self && <p className="muted small">Your own password and tokens are under Account.</p>}

      {(canDeactivate || user.disabled) && (
        <div className="editor-actions">
          {user.disabled ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={update.isPending}
              onClick={() => run({ disabled: false }, () => toast(`${user.displayName} can sign in again`, { kind: 'success' }))}
            >
              <UserCheck size={14} aria-hidden /> Re-enable
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-subtle" onClick={() => setConfirmDeactivate(true)}>
              <UserX size={14} aria-hidden /> Deactivate
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {confirmDeactivate && (
        <ConfirmDialog
          title={`Deactivate ${user.displayName}?`}
          message="They’re signed out everywhere, can’t sign in, and their API tokens stop working until you re-enable them. Their name stays in the history."
          danger
          confirmLabel="Deactivate"
          busy={update.isPending}
          onCancel={() => setConfirmDeactivate(false)}
          onConfirm={() =>
            run({ disabled: true }, () => {
              setConfirmDeactivate(false);
              toast(`${user.displayName} was deactivated`, { kind: 'success' });
            })
          }
        />
      )}
    </div>
  );
}

function AddPersonForm({ onDone }: { onDone: () => void }) {
  const ids = useId();
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<UserInfo | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = CreateUserBody.safeParse({ username, displayName, role, password });
    if (!body.success) {
      const issue = body.error.issues[0];
      const field = { username: 'Username', displayName: 'Display name', password: 'Temporary password' }[String(issue?.path[0])] ?? '';
      setError(`${field ? `${field}: ` : ''}${issue?.message ?? 'Check the form'}`);
      return;
    }
    create.mutate(body.data, {
      onSuccess: (u) => {
        setAdded(u);
        setUsername('');
        setDisplayName('');
        setRole('member');
        setPassword('');
      },
      onError: (err) => setError(peopleErrorMessage(err)),
    });
  }

  if (added) {
    return (
      <div className="notice notice-row" role="status">
        <UserCheck size={16} aria-hidden />
        <div className="form-stack">
          <p>
            Added {added.displayName} as {added.role === 'admin' ? 'an admin' : 'a member'}. They sign in as{' '}
            <strong>{added.username}</strong> with the temporary password you chose, then can change it under Account.
          </p>
          <div className="editor-actions">
            <button type="button" className="btn btn-sm" onClick={() => setAdded(null)}>
              Add another
            </button>
            <button type="button" className="btn btn-sm" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="form-stack person-new" onSubmit={submit} noValidate aria-label="Add person">
      <div className="field-row">
        <label className="field">
          <span className="field-label">Username</span>
          <input
            className="input"
            value={username}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
          <span className="field-help">What they sign in with: letters, digits, dots, dashes and underscores.</span>
        </label>
        <label className="field">
          <span className="field-label">Display name</span>
          <input className="input" value={displayName} maxLength={60} autoComplete="off" onChange={(e) => setDisplayName(e.target.value)} />
          <span className="field-help">How others see them in history.</span>
        </label>
      </div>
      <fieldset className="ticket-fieldset">
        <legend className="field-label">Role</legend>
        {(['member', 'admin'] as const).map((r) => (
          <label key={r} className="checkbox">
            <input type="radio" name={`${ids}-role`} checked={role === r} onChange={() => setRole(r)} />
            <span>{r === 'admin' ? 'Admin' : 'Member'}</span>
          </label>
        ))}
      </fieldset>
      <TempPasswordField
        label="Temporary password"
        help={`At least ${PASSWORD_MIN_LENGTH} characters. Hand it to them; they can change it under Account.`}
        value={password}
        onChange={setPassword}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !username.trim() || !displayName.trim() || !password}>
          <UserPlus size={14} aria-hidden /> {create.isPending ? 'Adding…' : 'Add person'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Easy to read aloud or type: no 0/O, 1/l/I. */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random temporary password (getRandomValues works over plain HTTP, unlike randomUUID). */
function generatePassword(length = 16): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    // Reject the top of the range so every character is equally likely.
    if (buf[0]! < 256 - (256 % PASSWORD_ALPHABET.length)) out.push(PASSWORD_ALPHABET[buf[0]! % PASSWORD_ALPHABET.length]!);
  }
  return out.join('');
}

function TempPasswordField({ label, help, value, onChange }: { label: string; help: string; value: string; onChange: (v: string) => void }) {
  const ids = useId();
  const [shown, setShown] = useState(false);
  const tooShort = value.length > 0 && value.length < PASSWORD_MIN_LENGTH;
  return (
    <div className="field">
      <label className="field-label" htmlFor={`${ids}-input`}>
        {label}
      </label>
      <div className="temp-password">
        <input
          id={`${ids}-input`}
          className="input input-mono"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          aria-invalid={tooShort || undefined}
          aria-describedby={`${ids}-help`}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onChange(generatePassword());
            setShown(true);
          }}
        >
          <Dices size={14} aria-hidden /> Generate
        </button>
        <button type="button" className="btn btn-sm btn-subtle" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />} {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      <span id={`${ids}-help`} className={tooShort ? 'field-help is-error' : 'field-help'}>
        {help}
      </span>
    </div>
  );
}
