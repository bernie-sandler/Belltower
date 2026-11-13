import {
  CardListQuery,
  ChecklistBody,
  ChecklistItemBody,
  CreateLinkBody,
  ReorderBody,
  TextPreviewQuery,
  UpdateChecklistItemBody,
  UpdateWorklogBody,
  WorklogBody,
} from '@tt/shared';
import { create as contentDisposition } from 'content-disposition';
import type { FastifyInstance } from 'fastify';
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs';
import type { AppDeps } from '../../app';
import { AppError, badRequest } from '../../errors';
import {
  addAttachments,
  attachmentPath,
  attachmentRow,
  deleteAttachment,
  textPreview,
  type UploadedFile,
} from '../../services/attachments';
import { listCards } from '../../services/cardParts';
import { archiveAllDone, getEditableCard } from '../../services/cards';
import {
  addChecklist,
  addChecklistItem,
  deleteChecklist,
  deleteChecklistItem,
  renameChecklist,
  reorderChecklistItems,
  reorderChecklists,
  updateChecklistItem,
} from '../../services/checklists';
import { createLink, deleteLink } from '../../services/links';
import { addWorklog, listRevisions, updateWorklog } from '../../services/worklog';
import { saveUploadPart, tooLarge } from '../uploads';
import { idParam, parse } from '../util';

/** Attachment responses can't run scripts or be framed, whatever the file contains. */
const ATTACHMENT_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

export function registerCardPartRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;

  // ---- card lists (link picker, Archive, Trash) ----
  app.get('/api/cards', async (req) => listCards(req.ctx, parse(CardListQuery, req.query)));
  app.post('/api/cards/archive-done', async (req) => ({ archived: archiveAllDone(req.ctx) }));

  // ---- checklists ----
  app.post('/api/cards/:id/checklists', async (req) => addChecklist(req.ctx, idParam(req), parse(ChecklistBody, req.body).title));
  app.put('/api/cards/:id/checklists/order', async (req) =>
    reorderChecklists(req.ctx, idParam(req), parse(ReorderBody, req.body).ids),
  );
  app.patch('/api/checklists/:id', async (req) => renameChecklist(req.ctx, idParam(req), parse(ChecklistBody, req.body).title));
  app.delete('/api/checklists/:id', async (req) => deleteChecklist(req.ctx, idParam(req)));
  app.post('/api/checklists/:id/items', async (req) =>
    addChecklistItem(req.ctx, idParam(req), parse(ChecklistItemBody, req.body).text),
  );
  app.put('/api/checklists/:id/items/order', async (req) =>
    reorderChecklistItems(req.ctx, idParam(req), parse(ReorderBody, req.body).ids),
  );
  app.patch('/api/checklist-items/:id', async (req) =>
    updateChecklistItem(req.ctx, idParam(req), parse(UpdateChecklistItemBody, req.body)),
  );
  app.delete('/api/checklist-items/:id', async (req) => deleteChecklistItem(req.ctx, idParam(req)));

  // ---- links ----
  app.post('/api/cards/:id/links', async (req) => {
    const body = parse(CreateLinkBody, req.body);
    return createLink(req.ctx, idParam(req), body.otherCardId, body.direction);
  });
  app.delete('/api/cards/:id/links/:linkId', async (req) => deleteLink(req.ctx, idParam(req), idParam(req, 'linkId')));

  // ---- work log ----
  app.post('/api/cards/:id/worklog', async (req, reply) =>
    reply.status(201).send(addWorklog(req.ctx, idParam(req), parse(WorklogBody, req.body))),
  );
  app.patch('/api/activity/:id', async (req) => updateWorklog(req.ctx, idParam(req), parse(UpdateWorklogBody, req.body)));
  app.get('/api/activity/:id/revisions', async (req) => listRevisions(req.ctx, idParam(req)));

  // ---- attachments ----
  app.post('/api/cards/:id/attachments', async (req) => {
    const cardId = idParam(req);
    getEditableCard(req.ctx, cardId); // fail fast before receiving files
    if (!req.isMultipart()) throw badRequest('validation', 'Expected a multipart/form-data upload');

    mkdirSync(config.tmpDir, { recursive: true });
    const files: UploadedFile[] = [];
    const tmpPaths: string[] = [];
    try {
      for await (const part of req.files()) {
        files.push(await saveUploadPart(part, config.tmpDir, config.maxUploadBytes, tmpPaths));
      }
      if (!files.length) throw badRequest('validation', 'No file was uploaded');
      return addAttachments(req.ctx, config.attachmentsDir, cardId, files);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(config.maxUploadBytes);
      if (code === 'FST_FILES_LIMIT') throw new AppError(413, 'too_large', 'Upload at most 10 files at a time');
      throw err;
    } finally {
      // Files that made it into place were renamed away; anything left is a partial upload.
      for (const p of tmpPaths) rmSync(p, { force: true });
    }
  });

  app.delete('/api/attachments/:id', async (req) => deleteAttachment(req.ctx, config.attachmentsDir, idParam(req)));

  app.get('/api/attachments/:id/text', async (req) =>
    textPreview(req.ctx, config.attachmentsDir, idParam(req), parse(TextPreviewQuery, req.query).mode),
  );

  /** The file itself. Images and text display inline; anything else (or ?download=1) downloads. */
  app.get('/api/attachments/:id', async (req, reply) => {
    const row = attachmentRow(req.ctx, idParam(req));
    const file = attachmentPath(config.attachmentsDir, row);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      throw new AppError(404, 'not_found', 'The file for this attachment is missing');
    }
    const download = (req.query as { download?: string }).download === '1';
    const inline = !download && (row.kind === 'image' || row.kind === 'text');
    const type =
      row.kind === 'image' ? row.mime_type : row.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return reply
      .header('Content-Type', type)
      .header('Content-Length', String(size))
      .header('Content-Disposition', contentDisposition(row.original_name, { type: inline ? 'inline' : 'attachment' }))
      .header('Content-Security-Policy', ATTACHMENT_CSP)
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      // An attachment id always refers to the same bytes.
      // A tag-restricted account may lose sight of the card later, so its browser keeps no copy.
      .header('Cache-Control', req.ctx.scope ? 'private, no-store' : 'private, max-age=31536000, immutable')
      .send(createReadStream(file));
  });
}

