import type { CardDetail } from '@tt/shared';
import { ApiError } from './client';

/** Human-friendly text for any error thrown by the API layer. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'network':
        return "Can't reach Tower Tracker. Check your connection.";
      case 'csrf':
        return 'The request was blocked by a security check. Reload the page and try again.';
      case 'unauthenticated':
        return 'Your session has ended. Please log in again.';
      case 'not_found':
        return 'That item no longer exists.';
      case 'role_column':
        return "The Triage and Done columns can't be deleted.";
      case 'too_large':
        return 'That is too large to upload.';
      case 'busy':
        return 'The server is busy. Try again in a moment.';
      case 'rate_limited': {
        const wait = retryAfterSec(err);
        return wait ? `Too many attempts. Try again in ${wait} s.` : 'Too many attempts. Try again later.';
      }
      case 'anchor_not_found':
      case 'invalid_target':
        return 'The board was out of date. It has been refreshed.';
      case 'card_deleted':
        return 'This card was moved to Trash (maybe on another device).';
      case 'card_archived':
        return 'This card was archived (maybe on another device).';
      case 'not_done':
        return 'Only cards in the Done column can be archived.';
      case 'password_changed':
        return 'The password was just changed elsewhere. Log in again and retry.';
      case 'bad_response':
        return 'Unexpected response from the server.';
      default:
        break;
    }
    // Claude drafting errors (ai_bad_key, ai_unreachable, …) carry a message written for the user.
    if (err.code.startsWith('ai_')) return err.message || fallback;
    if (err.status >= 500) return 'The server hit an error. Try again.';
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** A 409 version_conflict carries the server's current copy of the card. */
export function conflictCard(err: unknown): CardDetail | null {
  if (!(err instanceof ApiError) || err.code !== 'version_conflict') return null;
  const body = err.body as { card?: CardDetail } | null;
  return body?.card ?? null;
}

/** Seconds to wait from a 429 rate_limited response. */
export function retryAfterSec(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'rate_limited') return null;
  const v = (err.body as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof v === 'number' && v > 0 ? Math.ceil(v) : null;
}
