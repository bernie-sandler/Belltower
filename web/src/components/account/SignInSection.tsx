// Account → Sign-in: link your account to the install's single sign-on, or unlink it. Shown when
// single sign-on is set up (or you're still linked from before). Linking goes to the provider and
// comes back to /account?sso=linked, or ?sso_error=<code>.

import type { MeResponse } from '@tt/shared';
import { Link2, Link2Off, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthStatus } from '../../api/auth';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { useLinkSso, useUnlinkSso } from '../../api/oidc';
import { toast } from '../../lib/toast';
import { ssoErrorMessage } from '../auth/ssoMessages';
import { Section } from '../settings/SettingsPage';

export function SignInSection({ me }: { me: MeResponse }) {
  const { data: status } = useAuthStatus();
  const link = useLinkSso();
  const unlink = useUnlinkSso();
  const [params, setParams] = useSearchParams();
  const [justLinked] = useState(() => params.get('sso') === 'linked');
  // The code from the address, read once; its message follows the password sign-in mode as it loads.
  const [returnedCode, setReturnedCode] = useState(() => params.get('sso_error'));
  const [ownError, setOwnError] = useState<string | null>(null);
  const error = ownError ?? ssoErrorMessage(returnedCode, status?.passwordLogin);
  function setError(message: string | null) {
    setReturnedCode(null);
    setOwnError(message);
  }
  // Read the result once, then clean the address so a reload doesn't repeat it.
  useEffect(() => {
    if (!params.has('sso') && !params.has('sso_error')) return;
    setParams(
      (p) => {
        p.delete('sso');
        p.delete('sso_error');
        return p;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const sso = status?.sso ?? null;
  if (!sso && !me.ssoLinked && !error) return null;
  const label = sso?.label ?? 'single sign-on';
  // Password sign-in turned off: only the owner's password still works.
  const passwordOff = status?.passwordLogin === 'off' && !me.isOwner;
  const canUnlink = me.hasPassword && !passwordOff;

  function startLink() {
    setError(null);
    link.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      // The provider being unreachable comes with a message written for people.
      onError: (err) => setError(isApiError(err, 'sso_unreachable') ? err.message : errorMessage(err)),
    });
  }

  return (
    <Section icon={<LogIn size={16} aria-hidden />} title="Sign-in">
      {me.ssoLinked ? (
        <p className="muted">
          You can sign in with {label}.{' '}
          {passwordOff
            ? 'Password sign-in is turned off on this install, so this is your way in.'
            : me.hasPassword
              ? 'Your password works too.'
              : 'Your account has no password, so this is your way in.'}
        </p>
      ) : (
        <p className="muted">Link your {label} account to sign in with it.{passwordOff ? '' : ' Your password keeps working.'}</p>
      )}
      {justLinked && me.ssoLinked && (
        <p className="notice" role="status">
          Linked. Next time, use “Sign in with {label}” on the login page.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        {me.ssoLinked ? (
          <button
            type="button"
            className="btn"
            disabled={!canUnlink || unlink.isPending}
            title={
              canUnlink
                ? undefined
                : passwordOff
                  ? 'Password sign-in is turned off, so you would have no way in.'
                  : 'Without a password you would have no way in. Ask an admin to set one first.'
            }
            onClick={() => {
              setError(null);
              unlink.mutate(undefined, {
                onSuccess: () => toast(`Unlinked from ${label}`, { kind: 'success', durationMs: 2500 }),
                onError: (err) => setError(errorMessage(err)),
              });
            }}
          >
            <Link2Off size={14} aria-hidden /> Unlink
          </button>
        ) : (
          sso && (
            <button type="button" className="btn btn-primary" disabled={link.isPending} onClick={startLink}>
              <Link2 size={14} aria-hidden /> {link.isPending ? 'Opening…' : `Link ${label}`}
            </button>
          )
        )}
      </div>
    </Section>
  );
}
