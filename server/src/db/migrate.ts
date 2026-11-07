import type { DB } from './connection';
import { GUARD_TRIGGER_NAMES, GUARDS_SQL, MIGRATIONS, type Migration } from './schema';

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies pending migrations, each in its own transaction with foreign keys off (so table rebuilds
 * work) and the append-only guards dropped and recreated around it. `to` stops at a given version,
 * which restore uses to bring an old export's DB up step by step.
 */
export function migrate(db: DB, opts: { to?: number; migrations?: readonly Migration[] } = {}): number[] {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations.at(-1)?.version ?? 0;
  const target = opts.to ?? latest;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(
      `Database schema v${current} is newer than this version of Belltower supports (v${latest}). ` +
        'Upgrade the app or restore an older backup.',
    );
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current || m.version > target) continue;
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const name of GUARD_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        db.exec(m.sql);
        db.exec(GUARDS_SQL);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length) {
          throw new Error(`Migration ${m.version} (${m.name}) left ${violations.length} foreign key violation(s)`);
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    applied.push(m.version);
  }
  if (!applied.length && schemaVersion(db) > 0) syncGuards(db);
  return applied;
}

/** Recreates the append-only guards so an existing DB always has the current definitions. */
export function syncGuards(db: DB): void {
  db.transaction(() => {
    for (const name of GUARD_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(GUARDS_SQL);
  })();
}
