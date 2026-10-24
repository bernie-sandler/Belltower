import { create as contentDisposition } from 'content-disposition';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { AppError, badRequest } from '../../errors';
import { localDateOf } from '../../lib/localdate';
import { localTimeOf } from '../../lib/tz';
import { attachmentEntries, cancelRestore, confirmRestore, exportData, stageRestore } from '../../services/backup';
import { importCards } from '../../services/cardImport';
import { parse } from '../util';

const ConfirmBody = z.object({ confirm: z.literal('RESTORE') });
const CardImportBody = z.object({
  /** The pasted text (JSON, possibly inside ``` fences), or `data` already parsed. */
  text: z.string().max(2_000_000).optional(),
  data: z.unknown().optional(),
  dryRun: z.boolean().default(true),
});

export function registerPhase4Routes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, config } = deps;

  const stamp = () => {
    const now = ctx.clock.now();
    return `${localDateOf(now, ctx.tz).replace(/-/g, '')}-${localTimeOf(now.toISOString(), ctx.tz).replace(':', '')}`;
  };

  // ---- export ----
  app.get('/api/backup/export.json', async (_req, reply) => {
    const data = exportData(ctx, config.appVersion);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', contentDisposition(`tower-tracker-backup-${stamp()}.json`))
      .send(JSON.stringify(data, null, 1));
  });

  app.get('/api/backup/export.zip', async (_req, reply) => {
    const data = exportData(ctx, config.appVersion);
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(data, null, 1)), 'data.json');
    for (const e of attachmentEntries(data)) {
      const file = path.join(config.attachmentsDir, String(e.cardId), e.storedName);
      if (existsSync(file)) zip.addFile(file, e.zipPath, { compress: false }); // photos/logs: storing is faster
    }
    zip.end();
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(`tower-tracker-backup-${stamp()}.zip`))
      .send(zip.outputStream);
  });

  // ---- restore: upload → preview → confirm ----
  app.post('/api/backup/restore', async (req) => {
    if (!req.isMultipart()) throw badRequest('validation', 'Upload the backup file (.zip or .json)');
    mkdirSync(config.tmpDir, { recursive: true });
    const upload = path.join(config.tmpDir, `upload-${randomUUID()}.part`);
    try {
      const part = await req.file({ limits: { fileSize: config.maxImportBytes, files: 1 } });
      if (!part) throw badRequest('validation', 'No file was uploaded');
      try {
        await pipeline(part.file, createWriteStream(upload));
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new AppError(413, 'too_large', `Backups can be at most ${Math.round(config.maxImportBytes / 1024 / 1024)} MB (MAX_IMPORT_MB)`);
        }
        throw err;
      }
      if (part.file.truncated) throw new AppError(413, 'too_large', 'The backup is larger than MAX_IMPORT_MB');
      const head = Buffer.alloc(2);
      const fd = openSync(upload, 'r');
      readSync(fd, head, 0, 2, 0);
      closeSync(fd);
      const isZip = head.toString('latin1') === 'PK';
      return await stageRestore(ctx, {
        uploadPath: upload,
        isZip,
        tmpDir: config.tmpDir,
        attachmentsDir: config.attachmentsDir,
        maxBytes: config.maxImportBytes * 4,
      });
    } finally {
      rmSync(upload, { force: true });
    }
  });

  app.post('/api/backup/restore/:token/confirm', async (req) => {
    parse(ConfirmBody, req.body);
    const token = (req.params as { token: string }).token;
    const r = confirmRestore(ctx, token, { dbPath: config.dbPath, attachmentsDir: config.attachmentsDir, backupsDir: config.backupsDir });
    req.log.warn(`Restored from backup; previous database kept at ${r.previousDb}`);
    return { restored: true, previousDb: path.basename(r.previousDb) };
  });

  app.delete('/api/backup/restore/:token', async (req, reply) => {
    cancelRestore((req.params as { token: string }).token);
    return reply.status(204).send();
  });

  /** What's in /data/backups: nightly snapshots and pre-restore copies. */
  app.get('/api/backup/snapshots', async () => {
    if (!existsSync(config.backupsDir)) return [];
    return readdirSync(config.backupsDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = statSync(path.join(config.backupsDir, f));
        return { name: f, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  });

  // ---- card import (AI-friendly format) ----
  app.post('/api/import/cards', async (req, reply) => {
    const body = parse(CardImportBody, req.body);
    const input = body.text !== undefined ? body.text : body.data;
    if (input === undefined) throw badRequest('validation', 'Paste the cards to import');
    const result = importCards(ctx, input, body.dryRun);
    if (!body.dryRun && result.created.length === 0) {
      throw new AppError(400, 'validation', 'Nothing was imported: fix the errors shown in the preview', { result });
    }
    return reply.status(body.dryRun ? 200 : 201).send(result);
  });
}
