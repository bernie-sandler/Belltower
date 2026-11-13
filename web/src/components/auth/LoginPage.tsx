import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthStatus, useLogin } from '../../api/auth';
import { isApiError } from '../../api/client';
import { errorMessage, retryAfterSec } from '../../api/errors';
import { qk } from '../../api/keys';
import { AuthLayout } from './AuthLayout';
import { LockoutMessage, useLockout } from './lockout';
import { SsoButton, SsoError, useSsoError } from './SsoLogin';

/** The last username signed in with on this device (only when "Remember this device" was on). */
const LAST_USERNAME_KEY = 'tt:last-username';

function readLastUsername(): string {
  try {
    return localStorage.getItem(LAST_USERNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberUsername(username: string, remember: boolean): void {
  try {
    if (remember && username) localStorage.setItem(LAST_USERNAME_KEY, username);
    else localStorage.removeItem(LAST_USERNAME_KEY);
  } catch {
    // Storage blocked: nothing to remember.
  }
}

export function LoginPage() {
  const qc = useQueryClient();
  const login = useLogin();
  const lockout = useLockout();
  const inputRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(readLastUsername);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ssoError = useSsoError();
  const { data: status } = useAuthStatus();
  const [params] = useSearchParams();
  // /login?password opens the form in every mode: how the owner signs in with password sign-in off.
  const [askedForPassword] = useState(() => params.has('password'));
  const [opened, setOpened] = useState(false);
  const mode = status?.sso ? status.passwordLogin : 'shown';
  // Hidden behind a link: it also opens by itself when the provider sent someone back with a known error.
  const showForm = mode === 'shown' || askedForPassword || (mode === 'hidden' && (opened || ssoError.message !== null));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || lockout.locked || login.isPending) return;
    setError(null);
    const name = username.trim();
    // No username signs in the owner (how 1.4 signed in), as does the old saved name "tower-tracker".
    // mutateAsync rather than mutate's callbacks: success swaps this page for the app, and a
    // callback given to mutate() doesn't run once its component has unmounted.
    login.mutateAsync({ ...(name ? { username: name } : {}), password, remember }).then(
      () => rememberUsername(name, remember),
      (err: unknown) => {
        const wait = retryAfterSec(err);
        if (wait !== null) {
          lockout.lock(wait);
        } else if (isApiError(err, 'invalid_password')) {
          setError('Incorrect username or password.');
        } else if (isApiError(err, 'password_login_off')) {
          setError(`Password sign-in is turned off on this install. Use “Sign in with ${status?.sso?.label ?? 'single sign-on'}” instead.`);
        } else if (isApiError(err, 'setup_required')) {
          // No account exists any more (e.g. a fresh data folder): the gate shows setup.
          void qc.invalidateQueries({ queryKey: qk.auth });
        } else {
          setError(errorMessage(err));
        }
        setPassword('');
        inputRef.current?.focus();
      },
    );
  }

  return (
    <AuthLayout title="Log in">
      <SsoError message={ssoError.message} />
      <SsoButton orPassword={showForm} />
      {mode === 'hidden' && !showForm && (
        <p className="auth-password-link">
          <button type="button" className="link-btn" onClick={() => setOpened(true)}>
            Sign in with a password
          </button>
        </p>
      )}
      {showForm && (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field-label">Username</span>
            {/* Password managers file the password under this name (iOS Keychain included). */}
            <input
              className="input"
              type="text"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={100}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              autoFocus={!username}
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            {/* Stays enabled during a lockout so focus and the iOS keyboard aren't lost. */}
            <input
              ref={inputRef}
              className="input"
              type="password"
              name="password"
              autoComplete="current-password"
              enterKeyHint="go"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoFocus={!!username}
              required
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Remember this device</span>
          </label>
          <p className="field-help">
            {remember
              ? 'Stay signed in for 90 days on this device.'
              : 'Sign out when the browser closes or after 12 hours idle.'}
          </p>

          <LockoutMessage lockout={lockout} />
          {error && (
            <p id="login-error" className="form-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={!password || lockout.locked || login.isPending}
          >
            {login.isPending ? 'Logging in…' : lockout.locked ? 'Locked — please wait' : 'Log in'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
