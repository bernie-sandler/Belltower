import { useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH } from '@tt/shared';
import { Lock } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useAuthStatus, useChangePassword } from '../../api/auth';
import { isApiError } from '../../api/client';
import { useConfig } from '../../api/config';
import { errorMessage, retryAfterSec } from '../../api/errors';
import { qk } from '../../api/keys';
import { toast } from '../../lib/toast';
import { LockoutMessage, useLockout } from '../auth/lockout';
import { Modal } from '../common/Modal';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: config } = useConfig();
  const { data: auth } = useAuthStatus();
  const managed = config?.passwordManagedByEnv ?? auth?.passwordManagedByEnv ?? false;
  const change = useChangePassword();
  const lockout = useLockout();
  const ids = useId();
  const currentRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    !managed &&
    !lockout.locked &&
    current.length > 0 &&
    next.length >= PASSWORD_MIN_LENGTH &&
    confirm === next &&
    !change.isPending;

  const noticeId = `${ids}-managed`;
  const nextHelpId = `${ids}-next-help`;
  const confirmHelpId = `${ids}-confirm-help`;
  const errorId = `${ids}-error`;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          toast('Password changed. Other devices were signed out.', { kind: 'success' });
        },
        onError: (err) => {
          const wait = retryAfterSec(err);
          if (wait !== null) {
            lockout.lock(wait);
          } else if (isApiError(err, 'invalid_password')) {
            setError('The current password is incorrect.');
            setCurrent('');
            currentRef.current?.focus();
          } else if (isApiError(err, 'managed_by_env')) {
            // The container was restarted with APP_PASSWORD meanwhile; refresh so the form locks.
            setError('The password is now managed by the container environment (APP_PASSWORD).');
            void qc.invalidateQueries({ queryKey: qk.config });
            void qc.invalidateQueries({ queryKey: qk.auth });
          } else if (isApiError(err, 'password_changed')) {
            // Another device changed the password at the same moment; that change signed this
            // session out. Re-check the session: the app returns to the login page if it ended.
            setError('The password was just changed from another device. Log in again with the new password.');
            toast('The password was changed from another device. Log in again with the new password.', {
              kind: 'warning',
            });
            void qc.invalidateQueries({ queryKey: qk.auth });
          } else if (isApiError(err, 'unauthenticated')) {
            // The session ended; the app is already switching to the login page.
            setError('Your session has ended. Log in again, then retry.');
          } else {
            setError(errorMessage(err));
          }
        },
      },
    );
  }

  return (
    <Modal title="Settings" onClose={onClose} size="md">
      <div className="modal-body settings">
        <section className="settings-section" aria-labelledby={`${ids}-password`}>
          <h3 id={`${ids}-password`} className="section-title">
            Change password
          </h3>
          {managed && (
            <div id={noticeId} className="notice notice-row">
              <Lock size={16} aria-hidden />
              <p>
                The password is set with <code>APP_PASSWORD</code> or <code>APP_PASSWORD_FILE</code> in the
                container&apos;s environment, so it can&apos;t be changed here. Change the variable and recreate the
                container; that also signs out every device.
              </p>
            </div>
          )}
          <form onSubmit={submit} noValidate aria-describedby={managed ? noticeId : undefined}>
            <fieldset className="form-stack" disabled={managed}>
              <legend className="visually-hidden">Change password</legend>
              <input type="text" name="username" autoComplete="username" value="tower-tracker" readOnly hidden />
              <label className="field">
                <span className="field-label">Current password</span>
                <input
                  ref={currentRef}
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  aria-invalid={(error !== null && current.length === 0) || undefined}
                  onChange={(e) => {
                    setCurrent(e.target.value);
                    setError(null);
                  }}
                />
              </label>
              <label className="field">
                <span className="field-label">New password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  aria-invalid={tooShort || undefined}
                  aria-describedby={nextHelpId}
                  onChange={(e) => setNext(e.target.value)}
                />
                <span id={nextHelpId} className={tooShort ? 'field-help is-error' : 'field-help'}>
                  At least {PASSWORD_MIN_LENGTH} characters. Other signed-in devices will be signed out.
                </span>
              </label>
              <label className="field">
                <span className="field-label">Confirm new password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  enterKeyHint="done"
                  value={confirm}
                  aria-invalid={mismatch || undefined}
                  aria-describedby={mismatch ? confirmHelpId : undefined}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {mismatch && (
                  <span id={confirmHelpId} className="field-help is-error">
                    Passwords don&apos;t match.
                  </span>
                )}
              </label>
              <LockoutMessage lockout={lockout} />
              {error && (
                <p id={errorId} className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div>
                <button type="submit" className="btn btn-primary" disabled={!canSubmit} aria-busy={change.isPending || undefined}>
                  {change.isPending ? 'Saving…' : 'Change password'}
                </button>
              </div>
            </fieldset>
          </form>
        </section>

        <section className="settings-section" aria-labelledby={`${ids}-about`}>
          <h3 id={`${ids}-about`} className="section-title">
            About
          </h3>
          <dl className="about-list">
            <dt>Version</dt>
            <dd>{config?.appVersion ?? '…'}</dd>
            <dt>Time zone</dt>
            <dd>{config?.timeZone ?? '…'}</dd>
          </dl>
        </section>
      </div>
    </Modal>
  );
}
