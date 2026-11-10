import type { FastifyBaseLogger } from 'fastify';
import { getSetting, setSetting, stmt } from '../db/connection';
import type { Ctx } from '../services/context';
import { createOwner, ensureOwnerActiveAdmin, getOwner, hasUsers, setPasswordHash } from '../services/users';
import { generateSetupCode, hashPassword, verifyPassword } from './password';
import { deleteUserSessions } from './sessions';

export interface AuthState {
  /** One-time first-run code (printed to the log); null once an account exists. */
  setupCode: string | null;
  /**
   * Where the owner's password comes from. 'env' = APP_PASSWORD/APP_PASSWORD_FILE is authoritative;
   * 'ui' = set in the app; null = not set up yet. Other people's passwords are always set in the app.
   */
  passwordSource: 'env' | 'ui' | null;
}

/**
 * Leftovers from before 1.5 (or from a restore): API tokens nobody owns go to the owner, and
 * sessions that belong to nobody end. Idempotent.
 */
export function adoptLeftovers(ctx: Ctx): { tokens: number; sessions: number } {
  const owner = getOwner(ctx);
  const tokens = owner ? stmt(ctx.db, 'UPDATE api_tokens SET user_id = ? WHERE user_id IS NULL').run(owner.id).changes : 0;
  const sessions = stmt(ctx.db, 'DELETE FROM sessions WHERE user_id IS NULL').run().changes;
  return { tokens, sessions };
}

/**
 * Decides where the owner's password comes from at startup:
 * - APP_PASSWORD set: it wins. If it differs from the owner's password, store it and sign the owner
 *   out everywhere (nobody else). The owner is also made an active admin again, so "set
 *   APP_PASSWORD and restart" always gets you back in. On a fresh install it creates the owner `admin`.
 * - Otherwise, keep the stored password (so the env var can be removed after first boot).
 * - No account at all: generate a setup code and print it; only someone who can read the
 *   container log can claim the app, even if a proxy misconfiguration exposes it.
 */
export async function bootstrapAuth(ctx: Ctx, appPassword: string | null, log: FastifyBaseLogger): Promise<AuthState> {
  const adopted = adoptLeftovers(ctx);
  if (adopted.tokens) log.info(`Gave ${adopted.tokens} API token(s) from before accounts to the owner`);

  if (appPassword) {
    const owner = getOwner(ctx);
    if (!owner) {
      const hash = await hashPassword(appPassword);
      if (createOwner(ctx, { username: 'admin', displayName: 'Admin', passwordHash: hash }) !== null) {
        log.info('Created the owner account "admin" with APP_PASSWORD');
        adoptLeftovers(ctx);
      } else {
        log.warn('APP_PASSWORD is set but this install has accounts and no owner; it was not applied');
      }
    } else {
      if (!owner.password_hash || !(await verifyPassword(appPassword, owner.password_hash))) {
        setPasswordHash(ctx, owner.id, await hashPassword(appPassword));
        const n = deleteUserSessions(ctx, owner.id);
        log.info(`Password of "${owner.username}" (the owner) set from APP_PASSWORD${n ? `; signed out ${n} of its session(s)` : ''}`);
      }
      if (ensureOwnerActiveAdmin(ctx, owner.id)) log.info(`Re-enabled "${owner.username}" (the owner) as an admin because APP_PASSWORD is set`);
    }
    if (getSetting(ctx.db, 'password_source') !== 'env') setSetting(ctx.db, 'password_source', 'env');
    return { setupCode: null, passwordSource: 'env' };
  }

  if (hasUsers(ctx)) {
    if (getSetting(ctx.db, 'password_source') === 'env') {
      setSetting(ctx.db, 'password_source', 'ui');
      log.info("APP_PASSWORD is no longer set; keeping the owner's stored password (it can now be changed under Account)");
    }
    return { setupCode: null, passwordSource: 'ui' };
  }

  const code = generateSetupCode();
  log.warn(
    [
      '',
      '==================================================================',
      '  Belltower first-run setup',
      '  Open the app in your browser and enter this one-time setup code:',
      '',
      `      ${code}`,
      '',
      '  (Or set APP_PASSWORD and restart to skip this step.)',
      '==================================================================',
    ].join('\n'),
  );
  return { setupCode: code, passwordSource: null };
}
