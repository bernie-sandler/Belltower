// Typed fetch wrapper for the Belltower API.
//  - Same-origin cookie session; every non-GET request carries the CSRF header.
//  - Errors become ApiError { status, code, body } using the server's { error, message } shape.
//  - A 401 'unauthenticated' anywhere notifies the auth layer (back to the login page, no reload).

import { CSRF_HEADER, CSRF_VALUE, PASSIVE_HEADER } from '@tt/shared';
import type { ApiError as ApiErrorBody } from '@tt/shared';

export class ApiError extends Error {
  readonly status: number;
  /** The server's `error` code ('validation', 'version_conflict', ...), or 'network' / 'http_<status>'. */
  readonly code: string;
  /** Parsed response body (may include extra fields such as `card` or `retryAfterSec`). */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

let unauthenticatedHandler: (() => void) | null = null;

/** Called on any 401 'unauthenticated' response. */
export function setUnauthenticatedHandler(fn: () => void): void {
  unauthenticatedHandler = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function isErrorBody(v: unknown): v is ApiErrorBody {
  return Boolean(v) && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string';
}

let passiveDepth = 0;
/** Signals of fetches started passively: TanStack reuses one per fetch, so its retries stay passive too. */
const passiveSignals = new WeakSet<AbortSignal>();

/**
 * Runs `start`, marking the GET requests it starts (synchronously, as TanStack starts a refetch's
 * query function) as made by the app on its own: the server then doesn't slide the session's idle
 * expiry for them, so a tab left open still signs out after 12 idle hours.
 */
export function passively<T>(start: () => T): T {
  passiveDepth++;
  try {
    return start();
  } finally {
    passiveDepth--;
  }
}

/** `keepalive` lets a small request finish after the page is hidden or closed. */
export async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  opts: { keepalive?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
  if (method === 'GET' && (passiveDepth > 0 || (signal && passiveSignals.has(signal)))) {
    headers[PASSIVE_HEADER] = '1';
    if (signal) passiveSignals.add(signal);
  }
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    // A cancelled query (TanStack aborts the signal) is not a network failure.
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    throw new ApiError(0, 'network', "Can't reach Belltower. Check your connection.", null);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  let parsed = false;
  if (text) {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const b = isErrorBody(data) ? data : null;
    const err = new ApiError(
      res.status,
      b?.error ?? `http_${res.status}`,
      b?.message ?? `Request failed (${res.status} ${res.statusText})`,
      data,
    );
    if (res.status === 401 && err.code === 'unauthenticated') unauthenticatedHandler?.();
    throw err;
  }
  if (text && !parsed) {
    // e.g. an HTML error page from a reverse proxy
    throw new ApiError(res.status, 'bad_response', 'Unexpected response from the server.', text);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
};
