import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDatabase(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') {
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal') {
      db.close();
      throw new Error(
        `Could not enable SQLite WAL mode on ${file} (got "${String(mode)}"). ` +
          'On Unraid, map /data to a pool path such as /mnt/cache/appdata/tower-tracker.',
      );
    }
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

// Prepared-statement cache: better-sqlite3 statements are reusable and preparing is not free.
const cache = new WeakMap<DB, Map<string, Database.Statement>>();

export function stmt(db: DB, sql: string): Database.Statement {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

export function getSetting(db: DB, key: string): string | null {
  const row = stmt(db, 'SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  stmt(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function deleteSetting(db: DB, key: string): void {
  stmt(db, 'DELETE FROM settings WHERE key = ?').run(key);
}
