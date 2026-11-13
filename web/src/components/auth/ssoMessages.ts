// What `?sso_error=<code>` means, for the login page and Account → Sign-in. The server logs the
// details; these say what to do next.

import type { PasswordLoginMode, SsoErrorCode } from '@tt/shared';

const MESSAGES: Record<SsoErrorCode, string> = {
  not_configured: 'Single sign-on isn’t set up on this install any more. Log in with your password.',
  state: 'That sign-in expired or was started in another browser or tab. Try again.',
  denied: 'Sign-in was cancelled at the provider.',
  idp: 'Couldn’t finish signing in with the provider. Try again, or log in with your password. The server log has the details.',
  clock: 'The provider’s sign-in arrived outside its valid time. The clocks on this server and the provider probably differ: ask your admin to check NTP.',
  group: 'Your account at the provider isn’t in the group allowed to use Belltower. Ask your admin.',
  no_account: 'There’s no Belltower account for you yet. Ask an admin to add you, then link single sign-on under Account.',
  link_required: 'A Belltower account with your email already exists. Log in with its password, then link single sign-on under Account.',
  disabled: 'Your Belltower account is deactivated. Ask an admin.',
  link_session: 'You were signed out, or someone else signed in, while linking. Sign in again and retry.',
  taken: 'That provider account is already linked to another Belltower account.',
};

/** With password sign-in turned off, nobody but the owner can fall back on a password. */
const WITHOUT_PASSWORD: Partial<Record<SsoErrorCode, string>> = {
  idp: 'Couldn’t finish signing in with the provider. Try again, or ask your admin. The server log has the details.',
  no_account: 'There’s no Belltower account linked to you yet. Ask your admin.',
  link_required: 'A Belltower account with your email already exists, but it isn’t linked to single sign-on yet. Ask your admin.',
};

/** The message for a code from the address bar, or null for anything unknown. */
export function ssoErrorMessage(code: string | null, passwordLogin: PasswordLoginMode = 'shown'): string | null {
  if (!code || !Object.hasOwn(MESSAGES, code)) return null;
  const c = code as SsoErrorCode;
  return (passwordLogin === 'off' ? WITHOUT_PASSWORD[c] : undefined) ?? MESSAGES[c];
}
