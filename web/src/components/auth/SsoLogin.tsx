// The login page's single sign-on parts: the "Sign in with …" button and the message when the
// provider sent someone back with `?sso_error=`. The button is a link, not a form: the server
// redirects to the provider, and the CSP's form-action 'self' would block a form posting there.

import { LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthStatus } from '../../api/auth';
import { ssoErrorMessage } from './ssoMessages';

/** The message for `?sso_error=` (read once; the address is cleaned so a reload doesn't repeat it). */
export function useSsoError(): string | null {
  const [params, setParams] = useSearchParams();
  const [message] = useState(() => ssoErrorMessage(params.get('sso_error')));
  useEffect(() => {
    if (!params.has('sso_error')) return;
    setParams(
      (p) => {
        p.delete('sso_error');
        return p;
      },
      { replace: true },
    );
  }, [params, setParams]);
  return message;
}

export function SsoError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

/** "Sign in with Authentik", when single sign-on is set up. Password login stays below it. */
export function SsoButton() {
  const { data } = useAuthStatus();
  if (!data?.sso) return null;
  return (
    <div className="auth-sso">
      <a className="btn btn-block" href="/api/auth/oidc/start">
        <LogIn size={16} aria-hidden /> Sign in with {data.sso.label}
      </a>
      <p className="auth-sso-or" aria-hidden>
        or log in with your password
      </p>
    </div>
  );
}
