# Single sign-on (OIDC)

Belltower can let people sign in with your identity provider: [Authentik](#authentik), [Authelia](#authelia), or any
other OpenID Connect provider (Keycloak, Pocket ID, Zitadel, Kanidm…). It's optional and off by default. An admin
sets it up under **Settings → Single sign-on**.

**Password login always stays available.** If the provider is down or misconfigured, sign in with your password as
usual. A broken provider can't lock anyone out, and `APP_PASSWORD` still recovers the owner account
([INSTALL.md](INSTALL.md#forgot-the-password)).

## How it works

- The login page shows **Sign in with &lt;label&gt;** above the password form. It's a plain link: Belltower sends you
  to the provider and the provider sends you back.
- It uses the authorization code flow with PKCE (S256), `state` and `nonce`. The sign-in in progress travels in an
  encrypted `tt_oidc` cookie, so the server keeps nothing for it. Your browser has 10 minutes to get through the
  provider's login page, and restarting Belltower cancels sign-ins that are under way (start again).
- The ID token's signature is checked against the provider's published keys, along with its issuer, audience, nonce
  and times. Tokens signed with the client secret (HS256) are refused.
- Who you're signed in as, in this order:
  1. the Belltower account **linked** to your provider account;
  2. with **Link existing accounts by verified email** on, the one active account with the same email, when the
     provider says the email is verified. It never links an admin account, and does nothing when several active
     accounts share the email. Those people [link themselves](#linking-an-account) instead;
  3. with **Create accounts on first sign-in** on, a new **member** account. Its username comes from the username
     claim (`preferred_username` by default), lowercased, with anything outside `a-z 0-9 . _ -` replaced and `-2`,
     `-3`… added if it's taken. Its display name comes from `name`;
  4. otherwise you're sent back to the login page with a message.
- **Required group** (optional): only members of that group get in. It's checked at every sign-in and link, and
  the group must match exactly (it's case-sensitive). Removing someone from the group takes effect **at their next
  sign-in**: a device they're already signed in on stays signed in. To end their sessions now, deactivate them in
  Belltower too.
- **Deactivated** people are refused, as with passwords. That includes coming back with a new provider account whose
  verified email is the deactivated person's: they get "deactivated", not a fresh account.
- Signing in with single sign-on remembers the device, like "Remember this device" on the password form.

**With "Create accounts on first sign-in" on, the provider decides who gets in.** Deactivating someone in Belltower
blocks their account, but a different provider account with a different email would get a new one. The real off
switch is at the provider: remove the person from the required group (or the application), then deactivate them in
Belltower to end the sessions they already have.

**Only turn on "Link existing accounts by verified email" if people can't change their own email at the provider.**
Belltower trusts the provider's `email_verified` claim (it must be the boolean `true`). If someone could set their
address to a colleague's and have it count as verified, their first sign-in would open the colleague's account.
- Accounts created by single sign-on have no password, so they can only sign in with single sign-on. An admin can
  give them a temporary password if they need one.

## Before you start

1. **Set the app's address.** Under **Settings → General → This app’s address**, enter the address people use, such
   as `https://belltower.example.com`. Single sign-on can't be turned on without it. The **redirect URI** to register at
   the provider is that address plus `/api/auth/oidc/callback`. The Single sign-on section shows it with a Copy
   button.
2. **Use Belltower at that address.** The provider always sends people back to it. A sign-in started from another
   address (an IP or a Tailscale name) moves to the app's address first. Linking an account only works from the app's
   address.
3. **Behind a reverse proxy**, set `TRUST_PROXY` so Belltower sees the real host and HTTPS
   ([REMOTE-ACCESS.md](REMOTE-ACCESS.md)).
4. **Keep the clocks right.** ID tokens are only valid for a short time, with 30 seconds of tolerance for clock
   differences. Run NTP on the Docker host and on the provider's host.
5. **Use HTTPS for the provider.** A plain-HTTP issuer works only after turning on **Allow a plain-HTTP issuer (LAN
   only)**. The client secret and tokens then cross your network unencrypted.

The client secret is write-only: once saved it's never shown again, and it's never in an export. A saved secret
is still in the database file, so it's also in the nightly snapshots and the copies made before upgrades and
restores. To keep it out of all of them, set `OIDC_CLIENT_SECRET` (or `OIDC_CLIENT_SECRET_FILE` with a Docker secret)
in the container's environment. It then wins over a saved one ([INSTALL.md](INSTALL.md#settings-env)).

Changing the issuer to another host forgets a saved secret, so it isn't sent to the new host by mistake. A secret
from `OIDC_CLIENT_SECRET` can't be forgotten that way: it's sent to whatever issuer is configured. Update the
environment variable when you move to another provider.

## Authentik

1. In Authentik, open **Applications → Providers → Create** and pick **OAuth2/OpenID Provider**:
   - **Client type:** Confidential. Copy the **Client ID** and **Client Secret**.
   - **Redirect URIs/Origins:** choose **Strict** and paste the redirect URI from Belltower, for example
     `https://belltower.example.com/api/auth/oidc/callback`.
   - **Signing Key:** pick one (for example *authentik Self-signed Certificate*). Without one, Authentik signs ID
     tokens with the client secret (HS256), which Belltower doesn't accept.
   - Leave the default scopes: `openid`, `email` and `profile`. Authentik's `profile` scope includes `groups`.
2. Open **Applications → Applications → Create**, name it Belltower and choose the provider. To limit who can use
   it, bind a group or policy here, or use Belltower's **Required group**.
3. On the provider's page, copy the **OpenID Configuration Issuer**. It looks like
   `https://auth.example.com/application/o/belltower/`, with the slash at the end.
4. In Belltower, open **Settings → Single sign-on**, choose **Authentik**, and paste the issuer, client ID and client
   secret. Press **Test connection**, then tick **Turn on single sign-on** and **Save**.

## Authelia

1. Hash a new client secret: `authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72`. It
   prints the secret (for Belltower) and its digest (for Authelia).
2. Add Belltower as a client in Authelia's configuration, then restart Authelia:

   ```yaml
   identity_providers:
     oidc:
       clients:
         - client_id: 'belltower'
           client_name: 'Belltower'
           client_secret: '$pbkdf2-sha512$310000$…'  # the digest from step 1
           public: false
           authorization_policy: 'two_factor'
           redirect_uris:
             - 'https://belltower.example.com/api/auth/oidc/callback'
           scopes: ['openid', 'profile', 'email', 'groups']
           response_types: ['code']
           grant_types: ['authorization_code']
           require_pkce: true
           pkce_challenge_method: 'S256'
           token_endpoint_auth_method: 'client_secret_basic'
   ```

   The Single sign-on section shows this snippet with your own redirect URI and client ID filled in.
3. In Belltower, choose **Authelia**. The issuer is Authelia's own address, like `https://auth.example.com` (no path).
   Enter the client ID and the secret from step 1, press **Test connection**, then turn it on and **Save**.

Authelia sends email and groups only from its userinfo endpoint, not in the ID token. Belltower always reads both,
and the Authelia preset asks for the `groups` scope.

## Other providers

Choose **Custom**, which shows every field. Register a confidential client that uses the authorization code flow
with PKCE (S256) and the redirect URI. Enter the issuer exactly as the provider's
`/.well-known/openid-configuration` reports it. Change the scopes, the username claim and the groups claim if your
provider uses other names. Belltower authenticates to the token endpoint with `client_secret_basic`, or with
`client_secret_post` when that's the only method the provider lists.

## Linking an account

Someone who already has a Belltower account (with a password) can link it under **Account → Sign-in → Link**. Belltower
sends them to the provider and back, then links that provider account to the signed-in person. After that, **Sign in
with …** opens their account. **Unlink** removes the link. An account without a password can't unlink, since it would
have no way in left.

A provider account can be linked to only one Belltower account. Restoring a backup never brings links along: each
person on the install you restore into keeps their own ([BACKUP.md](BACKUP.md)).

## Troubleshooting

The login page says what went wrong. The container log has the details (`docker logs belltower`).

**"Couldn't finish signing in with the provider"** or Test connection fails:
- **Issuer slash.** The issuer must match what the provider reports, character for character. Authentik's ends with
  a slash (`…/application/o/<slug>/`), and Authelia's doesn't. The presets fix this for you. With Custom, Belltower
  tries the other spelling once on its own, and Test connection names the spelling the provider uses.
- **HTTP 404 from the issuer.** Wrong slug or path. Open `<issuer>/.well-known/openid-configuration` in a browser: it
  should show JSON.
- **The certificate isn't trusted.** A provider behind a private CA needs that CA in the container: mount it and set
  `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **HS256.** Authentik without a signing key signs with the client secret. Pick a signing key for the provider.
- **The provider says the redirect URI is invalid.** Check **This app’s address** (scheme, host and port) and register
  the redirect URI exactly as Belltower shows it.

**"That sign-in expired or was started in another browser or tab."** The 10 minutes ran out, a second sign-in was
started in another tab, Belltower restarted in the meantime, or the browser blocked the `tt_oidc` cookie. Start again
from the login page, at the app's address.

**"Couldn't finish signing in" right after the provider's page.** Look in the log: "signature doesn't match" means
the ID token wasn't signed with any of the provider's published keys (if the provider just rotated its key, try
again); "HS256" means Authentik needs a signing key.

**"…outside its valid time."** The clocks on the Docker host and the provider differ by more than 30 seconds. Fix
NTP on both.

**"…isn't in the group allowed to use Belltower."** The required group isn't in the provider's groups claim. Check
the exact group name, the groups claim name (`groups` by default), and that the scopes include what sends it (Authelia
needs `groups`).

**"There's no Belltower account for you yet."** Account creation is off. An admin adds the person, who then links
their account under Account. Or turn on **Create accounts on first sign-in**.

**"A Belltower account with your email already exists."** Email linking found an admin account, several accounts or
one already linked elsewhere. Sign in with that account's password and link it under Account.
