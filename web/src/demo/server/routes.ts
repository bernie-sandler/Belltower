// Every Fastify route in server/src/http/routes, answered in the browser.
//
// DemoApi lists each route with the response type the real server sends (from @tt/shared), and
// `routes` must implement exactly those keys with handlers returning exactly those types, so a
// change to a shared type breaks `npm run typecheck` until the demo follows. routes.test.ts checks
// the other direction: a new server route without an entry here fails the tests.
// See docs/DEMO.md.

import {
  ApiTokenBody,
  BlockedColumnBody,
  CalendarQuery,
  CardImportBody,
  CardListQuery,
  ChangePasswordBody,
  ChecklistBody,
  ChecklistItemBody,
  ColumnNameBody,
  CompleteCardBody,
  CreateCardBody,
  CreateLinkBody,
  CreateTicketBody,
  CSRF_HEADER,
  CSRF_VALUE,
  DeleteColumnQuery,
  DiscordSettingsBody,
  DraftTicketBody,
  GeneralSettingsBody,
  LabelBody,
  LoginBody,
  MoveCardBody,
  MoveCardsBody,
  ReorderBody,
  RequestTypeBody,
  ResolutionReasonsBody,
  SearchQuery,
  SubmitBody,
  SubmitSettingsBody,
  TemplateBody,
  UpdateCardBody,
  UpdateChecklistItemBody,
  UpdateLabelBody,
  UpdateTemplateBody,
  UpdateWorklogBody,
  WorklogBody,
  type ActivityEntry,
  type ActivityRevision,
  type AiStatus,
  type ApiTokenInfo,
  type AppConfig,
  type AuthStatus,
  type BoardResponse,
  type BulkDraft,
  type CalendarItem,
  type CardDetail,
  type CardSummary,
  type Column,
  type ImportPreview,
  type Label,
  type MoveCardResponse,
  type MoveCardsResponse,
  type PublicSubmitConfig,
  type RecurringTemplate,
  type RequestType,
  type SearchResult,
  type SettingsResponse,
  type StatusLinkInfo,
  type SubmitResult,
  type PublicTicketStatus,
  type TextPreview,
  type TicketDraft,
} from '@tt/shared';
import { version as APP_VERSION } from '../../../../package.json';
import { listActivity } from './activity';
import { importCards } from './cardImport';
import { listCards } from './cardParts';
import {
  archiveAllDone,
  archiveCard,
  completeCard,
  createCard,
  deleteCard,
  getBoard,
  getCard,
  getCardRow,
  getEditableCard,
  moveCard,
  moveCards,
  restoreCard,
  sortColumnByPriority,
  undeleteCard,
  updateCard,
} from './cards';
import {
  addChecklist,
  addChecklistItem,
  deleteChecklist,
  deleteChecklistItem,
  renameChecklist,
  reorderChecklistItems,
  reorderChecklists,
  updateChecklistItem,
} from './checklists';
import { calendarItems } from './calendar';
import { createColumn, deleteColumn, renameColumn, reorderColumns, setBlockedColumn } from './columns';
import type { Ctx } from './db';
import { badRequest, DemoError, idParam, notFound, notInDemo, parse } from './errors';
import { createLabel, deleteLabel, reorderLabels, updateLabel } from './labels';
import { createLink, deleteLink } from './links';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, runDueTemplates, runTemplateNow, updateTemplate } from './recurring';
import { searchCards } from './search';
import { publicStatus, resetStatusLinks, statusLink } from './status';
import {
  createRequestType,
  deleteRequestType,
  listRequestTypes,
  regenerateSubmitKey,
  reorderRequestTypes,
  setResolutionReasons,
  settingsResponse,
  updateDiscordSettings,
  updateGeneralSettings,
  updateRequestType,
  updateSubmitSettings,
} from './settings';
import { checkSubmitKey, MAX_UPLOAD_BYTES, publicSubmitConfig, submitTicket } from './submit';
import { addWorklog, listRevisions, updateWorklog } from './worklog';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DemoRequest {
  method: Method;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body, if any. */
  body: unknown;
  /** Multipart uploads (the submit page, attachments, restore). */
  form: FormData | null;
  headers: Headers;
}

export interface DemoResponse {
  status: number;
  body?: unknown;
}

/** One line per route the real server has, with the response type it sends. */
export interface DemoApi {
  // ---- auth (routes/auth.ts) ----
  'GET /api/auth/status': AuthStatus;
  'POST /api/auth/setup': void;
  'POST /api/auth/login': void;
  'POST /api/auth/logout': void;
  'POST /api/auth/password': void;
  // ---- board, columns, labels, cards (routes/board.ts) ----
  'GET /api/config': AppConfig;
  'GET /api/board': BoardResponse;
  'POST /api/columns': Column;
  'PATCH /api/columns/:id': Column;
  'PUT /api/columns/order': Column[];
  'PUT /api/board/blocked-column': void;
  'POST /api/columns/:id/sort-by-priority': { orders: Record<string, number[]> };
  'DELETE /api/columns/:id': void;
  'POST /api/labels': Label;
  'PATCH /api/labels/:id': Label;
  'PUT /api/labels/order': Label[];
  'DELETE /api/labels/:id': void;
  'POST /api/cards': CardDetail;
  'GET /api/cards/:id': CardDetail;
  'PATCH /api/cards/:id': CardDetail;
  'POST /api/cards/:id/move': MoveCardResponse;
  'POST /api/cards/move-many': MoveCardsResponse;
  'POST /api/cards/:id/complete': { card: CardDetail; orders: Record<string, number[]>; completed: number[] };
  'DELETE /api/cards/:id': void;
  'POST /api/cards/:id/undelete': CardDetail;
  'POST /api/cards/:id/archive': CardDetail;
  'POST /api/cards/:id/restore': CardDetail;
  'GET /api/cards/:id/activity': ActivityEntry[];
  'GET /api/cards/:id/status-link': StatusLinkInfo;
  // ---- card parts (routes/cardParts.ts) ----
  'GET /api/cards': CardSummary[];
  'POST /api/cards/archive-done': { archived: number };
  'POST /api/cards/:id/checklists': CardDetail;
  'PUT /api/cards/:id/checklists/order': CardDetail;
  'PATCH /api/checklists/:id': CardDetail;
  'DELETE /api/checklists/:id': CardDetail;
  'POST /api/checklists/:id/items': CardDetail;
  'PUT /api/checklists/:id/items/order': CardDetail;
  'PATCH /api/checklist-items/:id': CardDetail;
  'DELETE /api/checklist-items/:id': CardDetail;
  'POST /api/cards/:id/links': CardDetail;
  'DELETE /api/cards/:id/links/:linkId': CardDetail;
  'POST /api/cards/:id/worklog': ActivityEntry;
  'PATCH /api/activity/:id': ActivityEntry;
  'GET /api/activity/:id/revisions': ActivityRevision[];
  'POST /api/cards/:id/attachments': CardDetail;
  'DELETE /api/attachments/:id': CardDetail;
  'GET /api/attachments/:id/text': TextPreview;
  'GET /api/attachments/:id': never;
  // ---- search, calendar, templates (routes/phase3.ts) ----
  'GET /api/search': SearchResult[];
  'GET /api/calendar': CalendarItem[];
  'GET /api/templates': RecurringTemplate[];
  'GET /api/templates/:id': RecurringTemplate;
  'POST /api/templates': RecurringTemplate;
  'PATCH /api/templates/:id': RecurringTemplate;
  'DELETE /api/templates/:id': void;
  'POST /api/templates/:id/run': CardDetail;
  // ---- backup and card import (routes/phase4.ts) ----
  'GET /api/backup/export.json': never;
  'GET /api/backup/export.zip': never;
  'POST /api/backup/restore': never;
  'POST /api/backup/restore/:token/confirm': never;
  'DELETE /api/backup/restore/:token': void;
  'GET /api/backup/snapshots': { name: string; sizeBytes: number; modifiedAt: string }[];
  'POST /api/import/cards': ImportPreview;
  // ---- settings, request types, tokens (routes/settings.ts) ----
  'GET /api/settings': SettingsResponse;
  'PUT /api/settings/general': SettingsResponse;
  'PUT /api/settings/submit': SettingsResponse;
  'PUT /api/settings/resolutions': SettingsResponse;
  'POST /api/settings/submit/new-link': SettingsResponse;
  'POST /api/settings/submit/reset-status-links': SettingsResponse;
  'PUT /api/settings/discord': SettingsResponse;
  'POST /api/settings/discord/test': { ok: boolean; message: string; settings: SettingsResponse };
  'POST /api/settings/discord/digest-now': { ok: boolean; message: string; settings: SettingsResponse };
  'GET /api/request-types': RequestType[];
  'POST /api/request-types': RequestType;
  'PUT /api/request-types/order': RequestType[];
  'PUT /api/request-types/:id': RequestType;
  'DELETE /api/request-types/:id': void;
  'GET /api/tokens': ApiTokenInfo[];
  'POST /api/tokens': { token: string; info: ApiTokenInfo };
  'DELETE /api/tokens/:id': void;
  // ---- the public submit page (routes/submit.ts) ----
  'GET /api/public/submit/:key': PublicSubmitConfig;
  'POST /api/public/submit/:key': SubmitResult;
  'GET /api/public/status/:id/:sig': PublicTicketStatus;
  // ---- Add ticket (routes/tickets.ts) ----
  'GET /api/ai/status': AiStatus;
  'POST /api/ai/draft': TicketDraft;
  'POST /api/ai/draft-many': BulkDraft;
  'POST /api/tickets': CardDetail;
  // ---- automation API (routes/v1.ts): bearer tokens from other tools, never the web app ----
  'POST /api/v1/cards': never;
  'POST /api/v1/hooks/uptime-kuma': never;
}

export type RouteKey = keyof DemoApi;

interface RouteDef<R> {
  run: (ctx: Ctx, req: DemoRequest) => R;
  /** Success status; void routes answer 204. */
  status: number | ((req: DemoRequest) => number);
  /** Reachable signed out (the server's PUBLIC_ROUTES). */
  public?: boolean;
  /** GET routes normally only read; these may also change data (the recurring scheduler). */
  writes?: boolean;
}

const ok = <R>(run: (ctx: Ctx, req: DemoRequest) => R, extra: Partial<RouteDef<R>> = {}): RouteDef<R> => ({ run, status: 200, ...extra });
const created = <R>(run: (ctx: Ctx, req: DemoRequest) => R): RouteDef<R> => ({ run, status: 201 });
const noContent = (run: (ctx: Ctx, req: DemoRequest) => void, extra: Partial<RouteDef<void>> = {}): RouteDef<void> => ({
  run,
  status: 204,
  ...extra,
});
const id = (req: DemoRequest, name = 'id') => idParam(req.params, name);

const NO_FILES = 'attachments need the server’s file storage';
const NO_BACKUPS = 'backups and restores work on the server’s database';
const NO_DISCORD = 'Discord notifications are sent by the server';
const NO_CLAUDE = 'Claude drafting needs the server and an Anthropic API key';
const NO_AUTOMATION = 'the automation API is for other tools calling a real server';

export const routes: { [K in RouteKey]: RouteDef<DemoApi[K]> } = {
  'GET /api/auth/status': ok(
    (ctx) => ({ authenticated: ctx.s.session.signedIn, setupRequired: false, passwordManagedByEnv: false }),
    { public: true },
  ),
  'POST /api/auth/setup': noContent(
    () => {
      throw new DemoError(404, 'setup_not_available', 'A password has already been set');
    },
    { public: true },
  ),
  'POST /api/auth/login': noContent(
    (ctx, req) => {
      parse(LoginBody, req.body);
      // No password in the demo: any password signs you in.
      ctx.s.session.signedIn = true;
    },
    { public: true },
  ),
  'POST /api/auth/logout': noContent(
    (ctx) => {
      ctx.s.session.signedIn = false;
    },
    { public: true },
  ),
  'POST /api/auth/password': noContent((_ctx, req) => {
    parse(ChangePasswordBody, req.body);
    throw notInDemo('the demo has no password to change');
  }),

  'GET /api/config': ok((ctx) => ({
    appVersion: `${APP_VERSION} (demo)`,
    timeZone: ctx.tz,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    passwordManagedByEnv: false,
  })),
  'GET /api/board': ok(
    (ctx) => {
      runDueTemplates(ctx);
      return getBoard(ctx);
    },
    { writes: true },
  ),
  'POST /api/columns': ok((ctx, req) => createColumn(ctx, parse(ColumnNameBody, req.body).name)),
  'PATCH /api/columns/:id': ok((ctx, req) => renameColumn(ctx, id(req), parse(ColumnNameBody, req.body).name)),
  'PUT /api/columns/order': ok((ctx, req) => reorderColumns(ctx, parse(ReorderBody, req.body).ids)),
  'PUT /api/board/blocked-column': noContent((ctx, req) => setBlockedColumn(ctx, parse(BlockedColumnBody, req.body).columnId)),
  'POST /api/columns/:id/sort-by-priority': ok((ctx, req) => ({ orders: sortColumnByPriority(ctx, id(req)) })),
  'DELETE /api/columns/:id': noContent((ctx, req) =>
    deleteColumn(ctx, id(req), parse(DeleteColumnQuery, req.query).targetColumnId),
  ),
  'POST /api/labels': ok((ctx, req) => {
    const body = parse(LabelBody, req.body);
    return createLabel(ctx, body.name, body.color);
  }),
  'PATCH /api/labels/:id': ok((ctx, req) => updateLabel(ctx, id(req), parse(UpdateLabelBody, req.body))),
  'PUT /api/labels/order': ok((ctx, req) => reorderLabels(ctx, parse(ReorderBody, req.body).ids)),
  'DELETE /api/labels/:id': noContent((ctx, req) => deleteLabel(ctx, id(req))),
  'POST /api/cards': created((ctx, req) => createCard(ctx, parse(CreateCardBody, req.body), { source: 'manual' })),
  'GET /api/cards/:id': ok((ctx, req) => getCard(ctx, id(req))),
  'PATCH /api/cards/:id': ok((ctx, req) => updateCard(ctx, id(req), parse(UpdateCardBody, req.body))),
  'POST /api/cards/:id/move': ok((ctx, req) => moveCard(ctx, id(req), parse(MoveCardBody, req.body))),
  'POST /api/cards/move-many': ok((ctx, req) => {
    const { cardIds, ...position } = parse(MoveCardsBody, req.body);
    return moveCards(ctx, cardIds, position);
  }),
  'POST /api/cards/:id/complete': ok((ctx, req) => completeCard(ctx, id(req), parse(CompleteCardBody, req.body))),
  'DELETE /api/cards/:id': noContent((ctx, req) => deleteCard(ctx, id(req))),
  'POST /api/cards/:id/undelete': ok((ctx, req) => undeleteCard(ctx, id(req))),
  'POST /api/cards/:id/archive': ok((ctx, req) => archiveCard(ctx, id(req))),
  'POST /api/cards/:id/restore': ok((ctx, req) => restoreCard(ctx, id(req))),
  'GET /api/cards/:id/activity': ok((ctx, req) => {
    getCardRow(ctx, id(req));
    return listActivity(ctx, id(req));
  }),
  // Creates the signing secret the first time, like the server.
  'GET /api/cards/:id/status-link': ok((ctx, req) => statusLink(ctx, id(req)), { writes: true }),

  'GET /api/cards': ok((ctx, req) => listCards(ctx, parse(CardListQuery, req.query))),
  'POST /api/cards/archive-done': ok((ctx) => ({ archived: archiveAllDone(ctx) })),
  'POST /api/cards/:id/checklists': ok((ctx, req) => addChecklist(ctx, id(req), parse(ChecklistBody, req.body).title)),
  'PUT /api/cards/:id/checklists/order': ok((ctx, req) => reorderChecklists(ctx, id(req), parse(ReorderBody, req.body).ids)),
  'PATCH /api/checklists/:id': ok((ctx, req) => renameChecklist(ctx, id(req), parse(ChecklistBody, req.body).title)),
  'DELETE /api/checklists/:id': ok((ctx, req) => deleteChecklist(ctx, id(req))),
  'POST /api/checklists/:id/items': ok((ctx, req) => addChecklistItem(ctx, id(req), parse(ChecklistItemBody, req.body).text)),
  'PUT /api/checklists/:id/items/order': ok((ctx, req) => reorderChecklistItems(ctx, id(req), parse(ReorderBody, req.body).ids)),
  'PATCH /api/checklist-items/:id': ok((ctx, req) => updateChecklistItem(ctx, id(req), parse(UpdateChecklistItemBody, req.body))),
  'DELETE /api/checklist-items/:id': ok((ctx, req) => deleteChecklistItem(ctx, id(req))),
  'POST /api/cards/:id/links': ok((ctx, req) => {
    const body = parse(CreateLinkBody, req.body);
    return createLink(ctx, id(req), body.otherCardId, body.direction);
  }),
  'DELETE /api/cards/:id/links/:linkId': ok((ctx, req) => deleteLink(ctx, id(req), id(req, 'linkId'))),
  'POST /api/cards/:id/worklog': created((ctx, req) => addWorklog(ctx, id(req), parse(WorklogBody, req.body))),
  'PATCH /api/activity/:id': ok((ctx, req) => updateWorklog(ctx, id(req), parse(UpdateWorklogBody, req.body))),
  'GET /api/activity/:id/revisions': ok((ctx, req) => listRevisions(ctx, id(req))),
  'POST /api/cards/:id/attachments': ok((ctx, req) => {
    getEditableCard(ctx, id(req));
    throw notInDemo(NO_FILES);
  }),
  // The demo never has attachments, so every id is unknown.
  'DELETE /api/attachments/:id': ok(() => {
    throw notFound('Attachment not found');
  }),
  'GET /api/attachments/:id/text': ok(() => {
    throw notFound('Attachment not found');
  }),
  'GET /api/attachments/:id': ok(() => {
    throw notFound('Attachment not found');
  }),

  'GET /api/search': ok((ctx, req) => searchCards(ctx, parse(SearchQuery, req.query))),
  'GET /api/calendar': ok((ctx, req) => {
    const q = parse(CalendarQuery, req.query);
    return calendarItems(ctx, q.from, q.to);
  }),
  'GET /api/templates': ok((ctx) => listTemplates(ctx)),
  'GET /api/templates/:id': ok((ctx, req) => getTemplate(ctx, id(req))),
  'POST /api/templates': created((ctx, req) => {
    const t = createTemplate(ctx, parse(TemplateBody, req.body));
    runDueTemplates(ctx);
    return getTemplate(ctx, t.id);
  }),
  'PATCH /api/templates/:id': ok((ctx, req) => {
    updateTemplate(ctx, id(req), parse(UpdateTemplateBody, req.body));
    runDueTemplates(ctx);
    return getTemplate(ctx, id(req));
  }),
  'DELETE /api/templates/:id': noContent((ctx, req) => deleteTemplate(ctx, id(req))),
  'POST /api/templates/:id/run': created((ctx, req) => runTemplateNow(ctx, id(req), req.query.force === '1')),

  'GET /api/backup/export.json': ok(() => {
    throw notInDemo(NO_BACKUPS);
  }),
  'GET /api/backup/export.zip': ok(() => {
    throw notInDemo(NO_BACKUPS);
  }),
  'POST /api/backup/restore': ok(() => {
    throw notInDemo(NO_BACKUPS);
  }),
  'POST /api/backup/restore/:token/confirm': ok(() => {
    throw notInDemo(NO_BACKUPS);
  }),
  'DELETE /api/backup/restore/:token': noContent(() => undefined),
  'GET /api/backup/snapshots': ok(() => []),
  'POST /api/import/cards': {
    status: (req) => (parse(CardImportBody, req.body).dryRun ? 200 : 201),
    run: (ctx, req) => {
      const body = parse(CardImportBody, req.body);
      const input = body.text !== undefined ? body.text : body.data;
      if (input === undefined) throw badRequest('validation', 'Paste the cards to import');
      const result = importCards(ctx, input, body.dryRun);
      if (!body.dryRun && result.created.length === 0) {
        throw new DemoError(400, 'validation', 'Nothing was imported: fix the errors shown in the preview', { result });
      }
      return result;
    },
  },

  'GET /api/settings': ok((ctx) => settingsResponse(ctx)),
  'PUT /api/settings/general': ok((ctx, req) => {
    updateGeneralSettings(ctx, parse(GeneralSettingsBody, req.body));
    return settingsResponse(ctx);
  }),
  'PUT /api/settings/submit': ok((ctx, req) => {
    updateSubmitSettings(ctx, parse(SubmitSettingsBody, req.body));
    return settingsResponse(ctx);
  }),
  'PUT /api/settings/resolutions': ok((ctx, req) => {
    setResolutionReasons(ctx, parse(ResolutionReasonsBody, req.body).reasons);
    return settingsResponse(ctx);
  }),
  'POST /api/settings/submit/new-link': ok((ctx) => {
    regenerateSubmitKey(ctx);
    return settingsResponse(ctx);
  }),
  'POST /api/settings/submit/reset-status-links': ok((ctx) => {
    resetStatusLinks(ctx);
    return settingsResponse(ctx);
  }),
  'PUT /api/settings/discord': ok((ctx, req) => {
    const body = parse(DiscordSettingsBody, req.body);
    if (body.webhookUrl) throw notInDemo(NO_DISCORD);
    updateDiscordSettings(ctx, body);
    return settingsResponse(ctx);
  }),
  'POST /api/settings/discord/test': ok(() => {
    throw notInDemo(NO_DISCORD);
  }),
  'POST /api/settings/discord/digest-now': ok(() => {
    throw notInDemo(NO_DISCORD);
  }),
  'GET /api/request-types': ok((ctx) => listRequestTypes(ctx)),
  'POST /api/request-types': created((ctx, req) => createRequestType(ctx, parse(RequestTypeBody, req.body))),
  'PUT /api/request-types/order': ok((ctx, req) => reorderRequestTypes(ctx, parse(ReorderBody, req.body).ids)),
  'PUT /api/request-types/:id': ok((ctx, req) => updateRequestType(ctx, id(req), parse(RequestTypeBody, req.body))),
  'DELETE /api/request-types/:id': noContent((ctx, req) => deleteRequestType(ctx, id(req))),
  'GET /api/tokens': ok(() => []),
  'POST /api/tokens': ok((_ctx, req) => {
    parse(ApiTokenBody, req.body);
    throw notInDemo(`API tokens are for tools like Uptime Kuma, and ${NO_AUTOMATION}`);
  }),
  'DELETE /api/tokens/:id': noContent(() => {
    throw notFound('Token not found');
  }),

  'GET /api/public/submit/:key': ok((ctx, req) => publicSubmitConfig(ctx, req.params.key ?? ''), { public: true }),
  'GET /api/public/status/:id/:sig': ok((ctx, req) => publicStatus(ctx, req.params.id ?? '', req.params.sig ?? ''), { public: true }),
  'POST /api/public/submit/:key': {
    status: 201,
    public: true,
    run: (ctx, req) => {
      const key = req.params.key ?? '';
      checkSubmitKey(ctx, key);
      if (!req.form) throw badRequest('validation', 'Expected a multipart/form-data form');
      const files = req.form.getAll('screenshots').filter((f) => typeof f !== 'string');
      if (files.length) throw notInDemo('screenshots need the server’s file storage. Remove them and send again');
      let data: unknown;
      try {
        data = JSON.parse(String(req.form.get('data') ?? ''));
      } catch {
        throw badRequest('validation', 'The form data isn’t valid JSON');
      }
      return submitTicket(ctx, key, parse(SubmitBody, data));
    },
  },

  'GET /api/ai/status': ok(() => ({ enabled: false, model: null })),
  'POST /api/ai/draft': ok((_ctx, req) => {
    parse(DraftTicketBody, req.body);
    throw notInDemo(NO_CLAUDE);
  }),
  'POST /api/ai/draft-many': ok((_ctx, req) => {
    parse(DraftTicketBody, req.body);
    throw notInDemo(NO_CLAUDE);
  }),
  'POST /api/tickets': created((ctx, req) => {
    const { checklist, aiDrafted, links, ...body } = parse(CreateTicketBody, req.body);
    const card = createCard(
      ctx,
      { ...body, checklists: checklist?.length ? [{ title: 'Checklist', items: checklist }] : undefined },
      { source: 'manual', via: aiDrafted ? 'Add ticket (Claude draft)' : 'Add ticket' },
    );
    for (const l of links ?? []) createLink(ctx, card.id, l.cardId, l.direction);
    return links?.length ? getCard(ctx, card.id) : card;
  }),

  'POST /api/v1/cards': ok(() => {
    throw notInDemo(NO_AUTOMATION);
  }),
  'POST /api/v1/hooks/uptime-kuma': ok(() => {
    throw notInDemo(NO_AUTOMATION);
  }),
};

// ---------------------------------------------------------------------------------------------
// Matching and dispatch
// ---------------------------------------------------------------------------------------------

interface Compiled {
  key: RouteKey;
  method: Method;
  re: RegExp;
  names: string[];
  isStatic: boolean;
}

const compiled: Compiled[] = (Object.keys(routes) as RouteKey[])
  .map((key) => {
    const [method, pattern] = key.split(' ') as [Method, string];
    const names: string[] = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { key, method, re: new RegExp(`^${source}$`), names, isStatic: names.length === 0 };
  })
  // Static routes win over parametric ones, as in Fastify (PUT /order before PUT /:id).
  .sort((a, b) => Number(b.isStatic) - Number(a.isStatic));

export function matchRoute(method: string, path: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const c of compiled) {
    if (c.method !== method) continue;
    const m = c.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]!);
      } catch {
        params[n] = m[i + 1]!;
      }
    });
    return { key: c.key, params };
  }
  return null;
}

const errorBody = (e: DemoError) => ({ error: e.code, message: e.message, ...e.extra });

export interface DemoBackend {
  /** Runs `fn` against a copy of the state; `commit` saves the copy when it returns without throwing. */
  transaction<T>(fn: (ctx: Ctx) => T, commit: boolean | 'if-changed'): T;
  signedIn(): boolean;
}

/** Answers one API request: CSRF and sign-in checks like server/src/http/guard.ts, then the route. */
export function dispatch(backend: DemoBackend, req: Omit<DemoRequest, 'params'>): DemoResponse {
  try {
    if (req.method !== 'GET' && req.headers.get(CSRF_HEADER) !== CSRF_VALUE) {
      throw new DemoError(403, 'csrf', `Missing ${CSRF_HEADER} header`);
    }
    const match = matchRoute(req.method, req.path);
    if (!match) {
      if (!backend.signedIn()) throw new DemoError(401, 'unauthenticated', 'Please log in');
      throw new DemoError(404, 'not_found', `Route ${req.method}:${req.path} not found`);
    }
    const def = routes[match.key] as RouteDef<unknown>;
    if (!def.public && !backend.signedIn()) throw new DemoError(401, 'unauthenticated', 'Please log in');
    const full: DemoRequest = { ...req, params: match.params };
    const commit = req.method !== 'GET' ? true : def.writes ? 'if-changed' : false;
    const body = backend.transaction((ctx) => def.run(ctx, full), commit);
    const status = typeof def.status === 'function' ? def.status(full) : def.status;
    return status === 204 ? { status } : { status, body };
  } catch (err) {
    if (err instanceof DemoError) return { status: err.status, body: errorBody(err) };
    console.error('[Belltower demo]', err);
    return { status: 500, body: { error: 'internal', message: `Something went wrong in the demo: ${(err as Error).message}` } };
  }
}
