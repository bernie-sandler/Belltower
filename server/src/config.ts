import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  backupsDir: string;
  tmpDir: string;
  timeZone: string;
  /** From APP_PASSWORD / APP_PASSWORD_FILE. When set it is authoritative. */
  appPassword: string | null;
  maxUploadBytes: number;
  maxImportBytes: number;
  /** IPs/CIDRs of reverse proxies whose X-Forwarded-* headers we believe. */
  trustProxy: string[] | false;
  cookieSecure: 'auto' | 'true' | 'false';
  sessionDays: number;
  logLevel: string;
  /** Built SPA directory, or null when running the API alone (Vite dev server serves the UI). */
  webDistDir: string | null;
  appVersion: string;
  /** From ANTHROPIC_API_KEY / ANTHROPIC_API_KEY_FILE. Null keeps Add ticket fully offline. */
  anthropicApiKey: string | null;
  /** Claude model used to draft tickets. */
  aiModel: string;
  /** From OIDC_CLIENT_SECRET / OIDC_CLIENT_SECRET_FILE: the single sign-on client secret, overriding the saved one. */
  oidcClientSecret: string | null;
}

export class ConfigError extends Error {}

const MB = 1024 * 1024;

function intVar(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

export function parseTrustProxy(raw: string | undefined): string[] | false {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'false') return false;
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [addr, prefix, extra] = entry.split('/');
    const family = addr ? isIP(addr) : 0;
    const prefixOk =
      prefix === undefined ||
      (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (!family || !prefixOk || extra !== undefined) {
      throw new ConfigError(
        `TRUST_PROXY must be a comma-separated list of IP addresses or CIDR ranges of your reverse proxy ` +
          `(e.g. "192.168.1.20"). Got "${entry}". Values like "true" or "*" are rejected because they let any ` +
          `client spoof its IP address and bypass the login rate limit.`,
      );
    }
  }
  return entries;
}

function readPassword(env: NodeJS.ProcessEnv): string | null {
  const file = env.APP_PASSWORD_FILE?.trim();
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConfigError(`APP_PASSWORD_FILE could not be read (${file}): ${(err as Error).message}`);
    }
    const pw = text.replace(/\r?\n$/, '');
    if (!pw) throw new ConfigError('APP_PASSWORD_FILE is empty');
    return pw;
  }
  const pw = env.APP_PASSWORD;
  return pw ? pw : null;
}

/** A secret from NAME or NAME_FILE (Docker secrets style); the file wins. */
function readSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConfigError(`${name}_FILE could not be read (${file}): ${(err as Error).message}`);
    }
    const value = text.trim();
    if (!value) throw new ConfigError(`${name}_FILE is empty`);
    return value;
  }
  return env[name]?.trim() || null;
}

function defaultWebDist(): string | null {
  // Both src/config.ts (tsx dev) and dist/index.js (bundle) live one level below server/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../web/dist');
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeZone = env.TZ?.trim() || 'America/Chicago';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ConfigError(`TZ "${timeZone}" is not a valid IANA time zone (example: America/Chicago)`);
  }

  const cookieSecure = (env.COOKIE_SECURE?.trim().toLowerCase() || 'auto') as Config['cookieSecure'];
  if (!['auto', 'true', 'false'].includes(cookieSecure)) {
    throw new ConfigError(`COOKIE_SECURE must be auto, true or false (got "${env.COOKIE_SECURE}")`);
  }

  // In the container (NODE_ENV=production) data lives in /data; in dev, ./data under the cwd.
  const dataDir = path.resolve(env.DATA_DIR?.trim() || (env.NODE_ENV === 'production' ? '/data' : 'data'));
  const webDistDir = env.WEB_DIST_DIR?.trim() ? path.resolve(env.WEB_DIST_DIR.trim()) : defaultWebDist();

  return {
    port: intVar(env, 'PORT', 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'tower.db'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    backupsDir: path.join(dataDir, 'backups'),
    tmpDir: path.join(dataDir, 'tmp'),
    timeZone,
    appPassword: readPassword(env),
    maxUploadBytes: intVar(env, 'MAX_UPLOAD_MB', 25, 1, 10_240) * MB,
    maxImportBytes: intVar(env, 'MAX_IMPORT_MB', 2048, 1, 1_048_576) * MB,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cookieSecure,
    sessionDays: intVar(env, 'SESSION_DAYS', 90, 1, 3650),
    logLevel: env.LOG_LEVEL?.trim().toLowerCase() || 'info',
    webDistDir,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    anthropicApiKey: readSecret(env, 'ANTHROPIC_API_KEY'),
    aiModel: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5',
    oidcClientSecret: readSecret(env, 'OIDC_CLIENT_SECRET'),
  };
}
