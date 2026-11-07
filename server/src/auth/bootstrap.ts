import type { FastifyBaseLogger } from 'fastify';
import { getSetting, setSetting } from '../db/connection';
import type { Ctx } from '../services/context';
import { generateSetupCode, hashPassword, verifyPassword } from './password';
import { deleteAllSessions } from './sessions';

export interface AuthState {
  /** One-time first-run code (printed to the log); null once a password exists. */
  setupCode: string | null;
  /** 'env' = APP_PASSWORD/APP_PASSWORD_FILE is authoritative; 'ui' = set in the app; null = not set yet. */
  passwordSource: 'env' | 'ui' | null;
}

/**
 * Decides where the password comes from at startup:
 * - APP_PASSWORD set: it wins. If it differs from the stored hash, store it and sign out every device.
 * - Otherwise, keep any stored hash (so the env var can be removed after first boot).
 * - No password anywhere: generate a setup code and print it; only someone who can read the
 *   container log can claim the app, even if a proxy misconfiguration exposes it.
 */
export async function bootstrapAuth(
  ctx: Ctx,
  appPassword: string | null,
  log: FastifyBaseLogger,
): Promise<AuthState> {
  const stored = getSetting(ctx.db, 'password_hash');
  if (appPassword) {
    if (!stored || !(await verifyPassword(appPassword, stored))) {
      const hash = await hashPassword(appPassword);
      setSetting(ctx.db, 'password_hash', hash);
      setSetting(ctx.db, 'password_source', 'env');
      const n = deleteAllSessions(ctx);
      log.info(`Password set from APP_PASSWORD${n ? `; signed out ${n} session(s)` : ''}`);
    } else if (getSetting(ctx.db, 'password_source') !== 'env') {
      setSetting(ctx.db, 'password_source', 'env');
    }
    return { setupCode: null, passwordSource: 'env' };
  }

  if (stored) {
    if (getSetting(ctx.db, 'password_source') === 'env') {
      setSetting(ctx.db, 'password_source', 'ui');
      log.info('APP_PASSWORD is no longer set; keeping the stored password (it can now be changed in Settings)');
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
