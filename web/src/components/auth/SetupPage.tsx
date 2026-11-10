import { useQueryClient } from '@tanstack/react-query';
import { OWNER_ALIAS, PASSWORD_MIN_LENGTH } from '@tt/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useSetup } from '../../api/auth';
import { isApiError } from '../../api/client';
import { errorMessage, retryAfterSec } from '../../api/errors';
import { qk } from '../../api/keys';
import { AuthLayout } from './AuthLayout';
import { LockoutMessage, useLockout } from './lockout';

export function SetupPage() {
  const qc = useQueryClient();
  const setup = useSetup();
  const lockout = useLockout();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const name = username.trim().toLowerCase();
  const badName = !/^[a-z0-9._-]{2,32}$/.test(name) || name === OWNER_ALIAS;
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    code.trim().length > 0 &&
    !badName &&
    password.length >= PASSWORD_MIN_LENGTH &&
    confirm === password &&
    !setup.isPending &&
    !lockout.locked;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setup.mutate(
      { setupCode: code.trim(), username: name, password },
      {
        onError: (err) => {
          const wait = retryAfterSec(err);
          if (wait !== null) {
            lockout.lock(wait);
          } else if (isApiError(err, 'invalid_setup_code')) {
            setError(
              "That setup code isn't right. Copy it again from the container log — a new code is printed every time the container starts, so use the most recent one.",
            );
            codeRef.current?.focus();
            codeRef.current?.select();
          } else if (isApiError(err, 'setup_not_available')) {
            // An account already exists (set up elsewhere, or via APP_PASSWORD): go to login.
            void qc.invalidateQueries({ queryKey: qk.auth });
          } else {
            setError(errorMessage(err));
          }
        },
      },
    );
  }

  return (
    <AuthLayout title="Set up Belltower">
      <div className="auth-intro">
        <p>
          Create the owner account for this tracker. To prove you run the server, first enter the one-time setup code
          from the container log. It looks like <code>ABCDE-FGHJK-MNPQR-STUVW</code>.
        </p>
        <ul className="setup-steps">
          <li>
            <strong>Unraid:</strong> Docker tab → click the <em>belltower</em> icon → <em>Logs</em>.
          </li>
          <li>
            <strong>Terminal:</strong>
            <pre className="code-block">docker logs belltower</pre>
          </li>
        </ul>
        <p className="muted small">
          A new code is printed each time the container starts; use the newest one. To skip this step, set{' '}
          <code>APP_PASSWORD</code> in the compose file and recreate the container.
        </p>
      </div>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <label className="field">
          <span className="field-label">Setup code</span>
          <input
            ref={codeRef}
            className="input input-mono"
            name="setupCode"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            maxLength={64}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            autoFocus
            required
            aria-describedby="setup-code-help"
          />
          <span id="setup-code-help" className="field-help">
            Dashes and upper/lower case don&apos;t matter.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input
            className="input"
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={(username.length > 0 && badName) || undefined}
            aria-describedby="setup-username-help"
            required
          />
          <span id="setup-username-help" className={username.length > 0 && badName ? 'field-help is-error' : 'field-help'}>
            You sign in with it. 2–32 letters, digits, dots, dashes or underscores. You can add other people later.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={tooShort || undefined}
            aria-describedby="setup-pw-help"
            required
          />
          <span id="setup-pw-help" className={tooShort ? 'field-help is-error' : 'field-help'}>
            At least {PASSWORD_MIN_LENGTH} characters. A passphrase of a few words works well.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Confirm password</span>
          <input
            className="input"
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            enterKeyHint="go"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'setup-confirm-help' : undefined}
            required
          />
          {mismatch && (
            <span id="setup-confirm-help" className="field-help is-error">
              Passwords don&apos;t match.
            </span>
          )}
        </label>

        <LockoutMessage lockout={lockout} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
          {setup.isPending ? 'Saving…' : 'Create account and continue'}
        </button>
      </form>
    </AuthLayout>
  );
}
