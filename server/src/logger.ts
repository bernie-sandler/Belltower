// A small pino-compatible logger that writes human-readable lines, which read far better in the
// Unraid container log viewer than JSON. Fastify only needs info/warn/error/... and child().
import type { FastifyBaseLogger } from 'fastify';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity } as const;
type LevelName = keyof typeof LEVELS;

export interface LoggerOptions {
  level?: string;
  timeZone?: string;
  write?: (line: string) => void;
}

function isLevel(l: string): l is LevelName {
  return l in LEVELS;
}

export function createLogger(opts: LoggerOptions = {}, bindings: Record<string, unknown> = {}): FastifyBaseLogger {
  const level: LevelName = opts.level && isLevel(opts.level) ? opts.level : 'info';
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: opts.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const emit = (name: Exclude<LevelName, 'silent'>, args: unknown[]) => {
    if (LEVELS[name] < LEVELS[level]) return;
    let obj: Record<string, unknown> = {};
    let msg = '';
    const [a, b] = args;
    if (a instanceof Error) {
      obj = { err: a };
      msg = typeof b === 'string' ? b : a.message;
    } else if (a && typeof a === 'object') {
      obj = a as Record<string, unknown>;
      msg = typeof b === 'string' ? b : '';
    } else {
      msg = String(a ?? '');
    }
    const extras: string[] = [];
    let stack = '';
    for (const [k, v] of Object.entries({ ...bindings, ...obj })) {
      if (k === 'reqId' && LEVELS[name] < LEVELS.error) continue;
      if (v instanceof Error) {
        stack = v.stack ?? String(v);
        continue;
      }
      if (v === undefined) continue;
      extras.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    const line = `${fmt.format(new Date())} ${name.toUpperCase().padEnd(5)} ${msg}${extras.length ? ' ' + extras.join(' ') : ''}`;
    write(stack ? `${line}\n${stack}` : line);
  };

  const logger = {
    level,
    trace: (...args: unknown[]) => emit('trace', args),
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    fatal: (...args: unknown[]) => emit('fatal', args),
    silent: () => {},
    child: (childBindings: Record<string, unknown> = {}, childOpts?: { level?: string }) =>
      createLogger({ ...opts, level: childOpts?.level ?? level }, { ...bindings, ...childBindings }),
  };
  return logger as unknown as FastifyBaseLogger;
}
