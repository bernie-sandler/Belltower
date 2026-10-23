// Attachments live at <attachmentsDir>/<card id>/<uuid> (no extension, so nothing on disk is ever
// executed or served by its name). What a file is gets decided here from its content, never from
// the browser's guess:
//   - PNG/JPEG/GIF/WebP by magic bytes  -> 'image' (previewed inline)
//   - an allow-listed text extension with no NUL bytes in its first 8 KB -> 'text' (inline viewer)
//   - everything else -> 'file' (download only)

import { TEXT_EXTENSIONS, type CardDetail, type AttachmentKind, LIMITS, type TextPreview } from '@tt/shared';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { stmt } from '../db/connection';
import { AppError, notFound } from '../errors';
import { recordEvent } from './activity';
import type { AttachmentRow } from './cardParts';
import { getCard, getEditableCard, touchCard } from './cards';
import { nowIso, tx, type Ctx } from './context';
import { reindexCard } from './search';

export interface Sniffed {
  kind: AttachmentKind;
  mimeType: string;
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Decides what a file is from its first bytes (and, for text, its extension). */
export function sniff(head: Buffer, filename: string): Sniffed {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mimeType: 'image/png' };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mimeType: 'image/jpeg' };
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return { kind: 'image', mimeType: 'image/gif' };
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return { kind: 'image', mimeType: 'image/webp' };
  if (startsWith(head, ascii('%PDF-'))) return { kind: 'file', mimeType: 'application/pdf' };
  const ext = path.extname(filename).slice(1).toLowerCase();
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext) && !head.subarray(0, 8192).includes(0)) {
    return { kind: 'text', mimeType: 'text/plain' };
  }
  return { kind: 'file', mimeType: 'application/octet-stream' };
}

/** A safe display name: last path segment, no control characters, at most 255 characters. */
export function cleanFilename(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean || 'file';
}

export function attachmentRow(ctx: Ctx, id: number): AttachmentRow {
  const row = stmt(ctx.db, 'SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  if (!row) throw notFound('Attachment not found');
  return row;
}

/** Absolute path of an attachment's file, guaranteed to be inside the attachments folder. */
export function attachmentPath(attachmentsDir: string, row: AttachmentRow): string {
  const root = path.resolve(attachmentsDir);
  const p = path.resolve(root, String(row.card_id), row.stored_name);
  if (!p.startsWith(root + path.sep)) throw new AppError(500, 'internal', 'Invalid attachment path');
  return p;
}

export interface UploadedFile {
  /** Fully written temp file (same filesystem as the attachments folder, so it can be renamed). */
  tmpPath: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  /** The first bytes of the file, for type detection. */
  head: Buffer;
}

/** Moves an uploaded temp file into place and records it (one event per file). */
export function addAttachments(ctx: Ctx, attachmentsDir: string, cardId: number, files: UploadedFile[]): CardDetail {
  // Checked before touching the disk; the transaction below re-checks.
  getEditableCard(ctx, cardId);
  const placed: string[] = [];
  try {
    return tx(ctx, () => {
      getEditableCard(ctx, cardId);
      const dir = path.join(attachmentsDir, String(cardId));
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        const storedName = randomUUID();
        const name = cleanFilename(f.originalName);
        const { kind, mimeType } = sniff(f.head, name);
        const dest = path.join(dir, storedName);
        renameSync(f.tmpPath, dest);
        placed.push(dest);
        const id = Number(
          stmt(
            ctx.db,
            `INSERT INTO attachments (card_id, original_name, stored_name, mime_type, kind, size_bytes, sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(cardId, name, storedName, mimeType, kind, f.sizeBytes, f.sha256, nowIso(ctx)).lastInsertRowid,
        );
        recordEvent(ctx, cardId, 'attachment_added', { attachmentId: id, name, sizeBytes: f.sizeBytes });
      }
      touchCard(ctx, cardId);
      reindexCard(ctx, cardId);
      return getCard(ctx, cardId);
    });
  } catch (err) {
    // The DB rolled back: don't leave orphaned files behind.
    for (const p of placed) rmSync(p, { force: true });
    throw err;
  }
}

/** Removes the file and its row; the log keeps the file name. */
export function deleteAttachment(ctx: Ctx, attachmentsDir: string, id: number): CardDetail {
  const card = tx(ctx, () => {
    const row = attachmentRow(ctx, id);
    getEditableCard(ctx, row.card_id);
    stmt(ctx.db, 'DELETE FROM attachments WHERE id = ?').run(id);
    recordEvent(ctx, row.card_id, 'attachment_removed', {
      attachmentId: id,
      name: row.original_name,
      sizeBytes: row.size_bytes,
    });
    touchCard(ctx, row.card_id);
    return { row, detail: getCard(ctx, row.card_id) };
  });
  // After the commit: a failed unlink leaves a stray file, never a row without its file.
  rmSync(attachmentPath(attachmentsDir, card.row), { force: true });
  return card.detail;
}

function readRange(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The first or last part of a text attachment (logs are read from the end), or all of a small one. */
export function textPreview(ctx: Ctx, attachmentsDir: string, id: number, mode: 'head' | 'tail' | 'full'): TextPreview {
  const row = attachmentRow(ctx, id);
  if (row.kind !== 'text') throw new AppError(415, 'not_text', 'This attachment is not a text file');
  const file = attachmentPath(attachmentsDir, row);
  const total = statSync(file).size;
  const limit = LIMITS.textPreviewBytes;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  if (mode === 'full' || total <= limit) {
    if (total > LIMITS.textFullMaxBytes) {
      throw new AppError(413, 'too_large', 'This file is too large to show in full; download it instead');
    }
    return { text: decoder.decode(readRange(file, 0, total)), totalBytes: total, truncated: false, mode: 'full' };
  }
  if (mode === 'head') {
    let text = decoder.decode(readRange(file, 0, limit));
    const lastNl = text.lastIndexOf('\n');
    if (lastNl > text.length - 1024) text = text.slice(0, lastNl + 1); // end on a whole line
    return { text, totalBytes: total, truncated: true, mode: 'head' };
  }
  let text = decoder.decode(readRange(file, total - limit, limit));
  const firstNl = text.indexOf('\n');
  if (firstNl >= 0 && firstNl < 1024) text = text.slice(firstNl + 1); // start on a whole line
  return { text, totalBytes: total, truncated: true, mode: 'tail' };
}
