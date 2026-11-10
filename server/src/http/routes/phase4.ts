import { create as contentDisposition } from 'content-disposition';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { CardImportBody } from '@tt/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { AppError, badRequest } from '../../errors';
import { localDateOf } from '../../lib/localdate';
import { localTimeOf } from '../../lib/tz';
import { attachmentEntries, cancelRestore, confirmRestore, exportData, stageRestore } from '../../services/backup';
import { importCards } from '../../services/cardImport';
import { ADMIN } from '../guard';
import { parse } from '../util';

const ConfirmBody = z.object({ confirm: z.literal('RESTORE') });

export function registerPhase4Routes(app: FastifyInstance, deps: AppDeps): void {
  const { baseCtx, config } = deps;

  const stamp = () => {
    const now = baseCtx.clock.now();
    return `${localDateOf(now, baseCtx.tz).replace(/-/g, '')}-${localTimeOf(now.toISOString(), baseCtx.tz).replace(':', '')}`;
  };

  // ---- export ----
  app.get('/api/backup/export.json', ADMIN, async (req, reply) => {
    const data = exportData(req.ctx, config.appVersion);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', contentDisposition(`belltower-backup-${stamp()}.json`))
      .send(JSON.stringify(data, null, 1));
  });

  app.get('/api/backup/export.zip', ADMIN, async (req, reply) => {
    const data = exportData(req.ctx, config.appVersion);
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(data, null, 1)), 'data.json');
    for (const e of attachmentEntries(data)) {
      const file = path.join(config.attachmentsDir, String(e.cardId), e.storedName);
      if (existsSync(file)) zip.addFile(file, e.zipPath, { compress: false }); // photos/logs: storing is faster
    }
    zip.end();
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(`belltower-backup-${stamp()}.zip`))
      .send(zip.outputStream);
  });

  // ---- restore: upload → preview → confirm ----
  app.post('/api/backup/restore', ADMIN, async (req) => {
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
      return await stageRestore(req.ctx, {
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

  app.post('/api/backup/restore/:token/confirm', ADMIN, async (req) => {
    parse(ConfirmBody, req.body);
    const token = (req.params as { token: string }).token;
    // The base context: the restore closes its database and gives it the new one.
    const r = confirmRestore(baseCtx, token, { dbPath: config.dbPath, attachmentsDir: config.attachmentsDir, backupsDir: config.backupsDir });
    req.log.warn(`Restored from backup; previous database kept at ${r.previousDb}`);
    return { restored: true, previousDb: path.basename(r.previousDb) };
  });

  app.delete('/api/backup/restore/:token', ADMIN, async (req, reply) => {
    cancelRestore((req.params as { token: string }).token);
    return reply.status(204).send();
  });

  /** What's in /data/backups: nightly snapshots and pre-restore copies. */
  app.get('/api/backup/snapshots', ADMIN, async (req) => {
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
    const result = importCards(req.ctx, input, body.dryRun);
    if (!body.dryRun && result.created.length === 0) {
      throw new AppError(400, 'validation', 'Nothing was imported: fix the errors shown in the preview', { result });
    }
    return reply.status(body.dryRun ? 200 : 201).send(result);
  });
}
