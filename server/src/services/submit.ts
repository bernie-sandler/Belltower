// The public submit page: someone with the link picks a request type, answers its questions and
// files a ticket. The answers are appended to their description; the title follows the type's
// pattern ("Plex – {title} – {summary}") and the ticket gets the type's labels. Tickets land in
// the column set in Settings.

import {
  LIMITS,
  type PublicSubmitConfig,
  type RequestFieldDef,
  type RequestType,
  type SubmitBody,
  type SubmitResult,
} from '@tt/shared';
import { stmt } from '../db/connection';
import { AppError, badRequest, pageNotFound } from '../errors';
import { safeEqual } from '../lib/safeEqual';
import { addAttachments, sniff, type UploadedFile } from './attachments';
import { createCard } from './cards';
import { getRoleColumn } from './columns';
import type { Ctx } from './context';
import { listRequestTypes } from './requestTypes';
import { getSubmitSettings } from './settings';
import { statusLink } from './status';

/** Checks the key in the address (constant time). */
export function checkSubmitKey(ctx: Ctx, key: string): void {
  const s = getSubmitSettings(ctx);
  // The page is off, or the key is wrong: both look like "no such page" from outside.
  if (!s.enabled || !s.key || !safeEqual(key, s.key)) throw pageNotFound();
}

export function publicSubmitConfig(ctx: Ctx, key: string, maxUploadBytes: number): PublicSubmitConfig {
  checkSubmitKey(ctx, key);
  const s = getSubmitSettings(ctx);
  return {
    pageTitle: s.pageTitle,
    intro: s.intro,
    types: listRequestTypes(ctx)
      .filter((t) => t.enabled)
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        titlePattern: t.titlePattern,
        fields: t.fields,
      })),
    maxFiles: LIMITS.submitFiles,
    maxUploadBytes,
  };
}

type Answer = string | string[] | boolean;

/** "2026-10-28T19:30" → "2026-10-28 19:30" (the submitter's local time, as they entered it). */
function formatDateTime(v: string): string {
  return v.replace('T', ' ');
}

function answerText(f: RequestFieldDef, v: Answer): string {
  if (f.kind === 'yesno') return v ? 'Yes' : 'No';
  if (f.kind === 'multi') return (v as string[]).join(', ');
  if (f.kind === 'datetime') return formatDateTime(v as string);
  return v as string;
}

/** Checks one answer against its question; returns it cleaned, or null when left empty. */
function checkAnswer(f: RequestFieldDef, raw: Answer | undefined): Answer | null {
  const empty = raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (empty) {
    if (f.required && f.kind !== 'yesno') throw badRequest('validation', `Please answer “${f.label}”`);
    return f.kind === 'yesno' && f.required ? false : null;
  }
  const wrong = () => badRequest('validation', `“${f.label}”: that answer isn’t one of the choices`);
  switch (f.kind) {
    case 'short': {
      const s = String(raw).trim();
      if (s.length > 200 || /[\r\n]/.test(s)) throw badRequest('validation', `“${f.label}” should be one short line`);
      return s || null;
    }
    case 'long':
      return String(raw).trim() || null;
    case 'choice':
      if (typeof raw !== 'string' || !f.options.includes(raw)) throw wrong();
      return raw;
    case 'multi':
      if (!Array.isArray(raw) || !raw.every((x) => f.options.includes(x))) throw wrong();
      return [...new Set(raw)];
    case 'datetime':
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(raw)) {
        throw badRequest('validation', `“${f.label}” should be a date and time`);
      }
      return raw;
    case 'yesno':
      if (typeof raw !== 'boolean') throw badRequest('validation', `“${f.label}” should be yes or no`);
      return raw;
  }
}

/** Builds the ticket's title and description from a submission. Exported for tests. */
export function buildSubmission(type: RequestType, body: SubmitBody): { title: string; description: string } {
  const answers = new Map<string, Answer>();
  for (const f of type.fields) {
    const v = checkAnswer(f, body.answers[f.key]);
    if (v !== null) answers.set(f.key, v);
  }

  // Title: fill in the pattern; drop separators left around answers that were skipped.
  const filled = type.titlePattern.replace(/\{([a-z0-9_]+)\}/g, (_m, key: string) => {
    if (key === 'summary') return body.summary;
    const f = type.fields.find((x) => x.key === key);
    const v = answers.get(key);
    return f && v !== undefined ? answerText(f, v) : '';
  });
  const title = filled
    .split(/\s+[–—-]\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' – ')
    .replace(/\s+/g, ' ')
    .slice(0, LIMITS.cardTitle) || body.summary;

  const lines: string[] = [];
  const blocks: string[] = [];
  for (const f of type.fields) {
    const v = answers.get(f.key);
    if (v === undefined) continue;
    if (f.kind === 'long') blocks.push(`**${f.label}**\n\n${v as string}`);
    // "Media type:" but "When did it start?" (no colon after a question mark).
    else lines.push(`- **${/[?:]$/.test(f.label) ? f.label : `${f.label}:`}** ${answerText(f, v)}`);
  }
  const details = [lines.join('\n'), ...blocks].filter(Boolean).join('\n\n');
  const who = body.name ? ` by ${body.name}` : '';
  const description = [
    body.description.trim(),
    details ? `### ${type.name} details\n\n${details}` : '',
    `---\n_Submitted${who} through the submit page (${type.name})._`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, LIMITS.description);
  return { title, description };
}

/**
 * Files a ticket from the submit page. `files` are screenshots already written to temp files;
 * only images are accepted. A filled-in honeypot pretends to succeed and creates nothing.
 */
export function submitTicket(
  ctx: Ctx,
  key: string,
  body: SubmitBody,
  files: UploadedFile[],
  attachmentsDir: string,
): SubmitResult {
  checkSubmitKey(ctx, key);
  if (body.website) return { ticketNo: null, statusPath: null };
  if (files.length > LIMITS.submitFiles) throw new AppError(413, 'too_large', `Add at most ${LIMITS.submitFiles} screenshots`);
  for (const f of files) {
    if (sniff(f.head, f.originalName).kind !== 'image') {
      throw badRequest('validation', 'Screenshots must be images (PNG, JPEG, GIF or WebP)');
    }
  }

  const type = listRequestTypes(ctx).find((t) => t.id === body.typeId && t.enabled);
  if (!type) throw badRequest('validation', 'Pick what you need help with');
  const { title, description } = buildSubmission(type, body);

  const settings = getSubmitSettings(ctx);
  const columnExists =
    settings.columnId !== null && Boolean(stmt(ctx.db, 'SELECT 1 FROM columns WHERE id = ?').get(settings.columnId));
  const card = createCard(
    ctx,
    {
      title,
      description,
      columnId: columnExists ? settings.columnId! : getRoleColumn(ctx, 'triage').id,
      // The type's labels. Submitters don't pick any (a page opened before 1.6 may still send
      // tagLabelIds; they're ignored).
      labelIds: type.labelIds,
    },
    {
      source: 'api',
      sourceRef: 'submit',
      via: `submit page${body.name ? ` (${body.name})` : ''}`,
      external: true,
      submitPage: true,
    },
  );
  if (files.length) addAttachments(ctx, attachmentsDir, card.id, files);
  return { ticketNo: card.ticketNo, statusPath: statusLink(ctx, card.id).path };
}
