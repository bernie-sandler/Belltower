// Mirrors server/src/services/submit.ts: the public submit page.

import { LIMITS, type PublicSubmitConfig, type RequestFieldDef, type RequestType, type SubmitBody, type SubmitResult } from '@tt/shared';
import { createCard } from './cards';
import { getRoleColumn } from './columns';
import type { Ctx } from './db';
import { badRequest, notFound } from './errors';
import { listRequestTypes } from './settings';

/** The page is off, or the key is wrong: both look like "no such page" from outside. */
const NOT_FOUND = () => notFound('This page doesn’t exist');

/** Uploads need the server's file storage. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function checkSubmitKey(ctx: Ctx, key: string): void {
  const s = ctx.s.settings.submit;
  if (!s.enabled || !s.key || key !== s.key) throw NOT_FOUND();
}

export function publicSubmitConfig(ctx: Ctx, key: string): PublicSubmitConfig {
  checkSubmitKey(ctx, key);
  const s = ctx.s.settings.submit;
  const labels = new Map(ctx.s.labels.map((l) => [l.id, { id: l.id, name: l.name, color: l.color }]));
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
        tags: t.tagLabelIds.map((id) => labels.get(id)).filter((l) => l !== undefined),
      })),
    maxFiles: LIMITS.submitFiles,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

type Answer = string | string[] | boolean;

function answerText(f: RequestFieldDef, v: Answer): string {
  if (f.kind === 'yesno') return v ? 'Yes' : 'No';
  if (f.kind === 'multi') return (v as string[]).join(', ');
  if (f.kind === 'datetime') return (v as string).replace('T', ' ');
  return v as string;
}

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

/** The ticket's title and description from a submission. */
export function buildSubmission(type: RequestType, body: SubmitBody): { title: string; description: string } {
  const answers = new Map<string, Answer>();
  for (const f of type.fields) {
    const v = checkAnswer(f, body.answers[f.key]);
    if (v !== null) answers.set(f.key, v);
  }

  const filled = type.titlePattern.replace(/\{([a-z0-9_]+)\}/g, (_m, key: string) => {
    if (key === 'summary') return body.summary;
    const f = type.fields.find((x) => x.key === key);
    const v = answers.get(key);
    return f && v !== undefined ? answerText(f, v) : '';
  });
  const title =
    filled
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

/** Files a ticket from the submit page. A filled-in honeypot pretends to succeed and creates nothing. */
export function submitTicket(ctx: Ctx, key: string, body: SubmitBody): SubmitResult {
  checkSubmitKey(ctx, key);
  if (body.website) return { ticketNo: null };
  const type = listRequestTypes(ctx).find((t) => t.id === body.typeId && t.enabled);
  if (!type) throw badRequest('validation', 'Pick what you need help with');
  const tags = body.tagLabelIds.filter((id) => type.tagLabelIds.includes(id));
  const { title, description } = buildSubmission(type, body);
  const { columnId } = ctx.s.settings.submit;
  const columnExists = columnId !== null && ctx.s.columns.some((c) => c.id === columnId);
  const card = createCard(
    ctx,
    {
      title,
      description,
      columnId: columnExists ? columnId : getRoleColumn(ctx, 'triage').id,
      labelIds: [...new Set([...(type.typeLabelId !== null ? [type.typeLabelId] : []), ...tags])],
    },
    { source: 'api', sourceRef: 'submit', via: `submit page${body.name ? ` (${body.name})` : ''}` },
  );
  return { ticketNo: card.ticketNo };
}
