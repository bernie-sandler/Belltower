import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useLogin } from '../../api/auth';
import { isApiError } from '../../api/client';
import { errorMessage, retryAfterSec } from '../../api/errors';
import { qk } from '../../api/keys';
import { AuthLayout } from './AuthLayout';
import { LockoutMessage, useLockout } from './lockout';

export function LoginPage() {
  const qc = useQueryClient();
  const login = useLogin();
  const lockout = useLockout();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || lockout.locked || login.isPending) return;
    setError(null);
    login.mutate(
      { password, remember },
      {
        onError: (err) => {
          const wait = retryAfterSec(err);
          if (wait !== null) {
            lockout.lock(wait);
          } else if (isApiError(err, 'invalid_password')) {
            setError('Incorrect password.');
          } else if (isApiError(err, 'setup_required')) {
            // No password exists any more (e.g. a fresh data folder): the gate shows setup.
            void qc.invalidateQueries({ queryKey: qk.auth });
          } else {
            setError(errorMessage(err));
          }
          setPassword('');
          inputRef.current?.focus();
        },
      },
    );
  }

  return (
    <AuthLayout title="Log in">
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {/* Lets password managers (incl. iOS Keychain) file the password under a name. */}
        <input type="text" name="username" autoComplete="username" value="tower-tracker" readOnly hidden />
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
            autoFocus
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
    </AuthLayout>
  );
}
