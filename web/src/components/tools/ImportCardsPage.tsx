// Import cards (/import): paste the JSON an AI produced (or load a .json file), preview exactly
// what will be created, then import. "Copy AI prompt" gives the AI the format and your real
// column and label names.

import {
  PRIORITY_CODES,
  SEVERITY_CODES,
  type Priority,
  type Severity,
} from '@tt/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleCheck, ClipboardCopy, FileUp, FolderOpen, Sparkles, Upload, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { sortedColumns, useBoard } from '../../api/board';
import { api, isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { qk } from '../../api/keys';
import { buildAiPrompt } from '../../lib/aiPrompt';
import { cls } from '../../lib/cls';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { useOpenCard } from '../../lib/navigation';
import { formatDue, todayLocal } from '../../lib/time';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

/** Another card in this import (by position) or one already on the board. */
type ImportRef = { batchIndex: number; title: string } | { id: number; ticketNo: string | null; title: string };

const LINK_WORDS = { blocks: 'blocks', blocked_by: 'blocked by', relates: 'related to' } as const;

interface ImportItem {
  index: number;
  /** "2" for a top-level card, "2.1" for a ticket nested under it. */
  label: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  card: {
    kind: 'ticket' | 'work';
    parent: ImportRef | null;
    links: { direction: 'blocks' | 'blocked_by' | 'relates'; target: ImportRef }[];
    title: string;
    description: string;
    column: { id: number; name: string };
    labels: { name: string; existing: boolean }[];
    priority: Priority | null;
    severity: Severity | null;
    dueDate: string | null;
    dueTime: string | null;
    checklists: { title: string; items: string[] }[];
    worklog: { bodyMd: string; occurredAt: string | null }[];
  } | null;
}

interface ImportResult {
  items: ImportItem[];
  created: number[];
}

const DRAFT = 'import:cards';

/** "card 1.2 “Title”" for a card in this import, "261027-1 “Title”" for one on the board. */
function refText(ref: ImportRef, items: { label: string }[]): string {
  const where = 'batchIndex' in ref ? `card ${items[ref.batchIndex]?.label ?? ''}` : (ref.ticketNo ?? '');
  return `${where} “${ref.title}”`;
}

/** Copy that also works over plain HTTP (no secure context, so no navigator.clipboard). */
function copyText(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function ImportCardsPage() {
  const { data: board } = useBoard();
  const qc = useQueryClient();
  const openCard = useOpenCard();
  const [text, setText] = useState(() => loadDraft(DRAFT, true) ?? '');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const prompt = useMemo(
    () =>
      board
        ? buildAiPrompt(
            sortedColumns(board.columns),
            board.labels,
            todayLocal(),
            board.cards.filter((c) => c.kind === 'work' && c.id > 0 && !c.completedAt),
          )
        : '',
    [board],
  );

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResult>('/api/import/cards', { text, dryRun }),
    meta: { errorToast: false },
  });

  function preview() {
    setParseError(null);
    run.mutate(true, {
      onSuccess: setResult,
      onError: (err) => {
        setResult(null);
        setParseError(errorMessage(err));
      },
    });
  }

  function doImport() {
    run.mutate(false, {
      onSuccess: (r) => {
        setResult(r);
        clearDraft(DRAFT, true);
        setText('');
        void qc.invalidateQueries({ queryKey: qk.board });
        const n = r.created.length;
        toast(`Imported ${n} card${n === 1 ? '' : 's'}`, {
          kind: 'success',
          action: n === 1 ? { label: 'Open', onClick: () => openCard(r.created[0]!) } : undefined,
        });
      },
      onError: (err) => {
        if (isApiError(err, 'validation') && (err.body as { result?: ImportResult })?.result) {
          setResult((err.body as { result: ImportResult }).result);
        } else setParseError(errorMessage(err));
      },
    });
  }

  const items = result?.items ?? [];
  const valid = items.length > 0 && items.every((i) => i.ok);
  const imported = (result?.created.length ?? 0) > 0;

  return (
    <div className="list-page import-page">
      <h2 className="list-page-title">
        <FileUp size={20} aria-hidden /> Import cards
      </h2>
      <p className="muted">
        Describe a problem to an AI with the prompt below, paste its answer here, check the preview, then import. You
        can also load a <code>.json</code> file.
      </p>

      <div className="import-prompt">
        <div className="import-prompt-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!prompt}
            onClick={() => {
              if (copyText(prompt)) toast('AI prompt copied. Paste it into your AI, then add your problem.', { kind: 'success' });
              else {
                setShowPrompt(true);
                toast("Couldn't copy automatically; select the prompt below and copy it.", { kind: 'warning' });
              }
            }}
          >
            <Sparkles size={16} aria-hidden /> Copy AI prompt
          </button>
          <button type="button" className="btn" onClick={() => setShowPrompt((s) => !s)}>
            {showPrompt ? 'Hide prompt' : 'Show prompt'}
          </button>
        </div>
        {showPrompt && (
          <textarea className="input input-mono import-prompt-text" readOnly value={prompt} rows={14} onFocus={(e) => e.currentTarget.select()} />
        )}
      </div>

      <label className="field">
        <span className="field-label">AI answer or card JSON</span>
        <AutoGrowTextarea
          className="input input-mono import-input"
          rows={8}
          placeholder={'```json\n{ "format": "tower-tracker/cards@1", "cards": [ { "title": "…" } ] }\n```'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            saveDraft(DRAFT, e.target.value, true);
            setResult(null);
            setParseError(null);
          }}
        />
      </label>
      <div className="editor-actions">
        <button type="button" className="btn btn-primary" onClick={preview} disabled={!text.trim() || run.isPending}>
          Preview
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          <Upload size={16} aria-hidden /> Load .json file
        </button>
        {text && (
          <button
            type="button"
            className="btn btn-subtle"
            onClick={() => {
              setText('');
              clearDraft(DRAFT, true);
              setResult(null);
            }}
          >
            Clear
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json,text/plain"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const t = await f.text();
            setText(t);
            saveDraft(DRAFT, t, true);
            setResult(null);
          }}
        />
      </div>

      {parseError && (
        <p className="form-error" role="alert">
          {parseError}
        </p>
      )}

      {items.length > 0 && !imported && (
        <section className="import-preview" aria-label="Preview">
          <h3 className="card-section-title">
            Preview: {items.length} card{items.length === 1 ? '' : 's'}
            {valid ? (
              <span className="tag tag-success">
                <CircleCheck size={12} aria-hidden /> Ready
              </span>
            ) : (
              <span className="tag tag-danger">
                <XCircle size={12} aria-hidden /> Fix the errors below; nothing is imported until every card is valid
              </span>
            )}
          </h3>
          <ol className="import-cards">
            {items.map((it) => (
              <li key={it.index} className={cls('import-card', !it.ok && 'has-errors', it.label.includes('.') && 'is-nested')}>
                {it.card ? (
                  <>
                    <div className="import-card-head">
                      <span className="muted small import-card-label">{it.label}</span>
                      {it.card.kind === 'work' && (
                        <span className="badge work-badge">
                          <FolderOpen size={12} aria-hidden /> Work
                        </span>
                      )}
                      {it.card.priority && (
                        <span className={cls('badge level-badge', `prio-badge-${it.card.priority}`)}>{PRIORITY_CODES[it.card.priority]}</span>
                      )}
                      {it.card.severity && (
                        <span className={cls('badge level-badge', `sev-badge-${it.card.severity}`)}>{SEVERITY_CODES[it.card.severity]}</span>
                      )}
                      <strong className="import-card-title">{it.card.title}</strong>
                    </div>
                    <span className="muted small">
                      → {it.card.column.name}
                      {it.card.parent && ` · part of ${refText(it.card.parent, items)}`}
                      {it.card.links.map((l) => ` · ${LINK_WORDS[l.direction]} ${refText(l.target, items)}`).join('')}
                      {it.card.labels.length > 0 && ` · ${it.card.labels.map((l) => l.name + (l.existing ? '' : ' (new)')).join(', ')}`}
                      {it.card.dueDate && ` · due ${formatDue(it.card.dueDate, it.card.dueTime)}`}
                      {it.card.checklists.length > 0 && ` · ${it.card.checklists.reduce((n, c) => n + c.items.length, 0)} checklist items`}
                      {it.card.worklog.length > 0 && ` · ${it.card.worklog.length} work-log entr${it.card.worklog.length === 1 ? 'y' : 'ies'}`}
                    </span>
                    {it.card.description && <p className="import-card-desc">{it.card.description.slice(0, 280)}{it.card.description.length > 280 && '…'}</p>}
                  </>
                ) : (
                  <strong>Card {it.label}</strong>
                )}
                {it.errors.map((e) => (
                  <p key={e} className="form-error small">
                    <XCircle size={12} aria-hidden /> {e}
                  </p>
                ))}
                {it.warnings.map((w) => (
                  <p key={w} className="import-warning small">
                    <AlertTriangle size={12} aria-hidden /> {w}
                  </p>
                ))}
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-primary" disabled={!valid || run.isPending} onClick={doImport}>
            <ClipboardCopy size={16} aria-hidden /> Import {items.length} card{items.length === 1 ? '' : 's'}
          </button>
        </section>
      )}

      {imported && result && (
        <section className="import-preview" aria-label="Imported">
          <h3 className="card-section-title">
            <CircleCheck size={16} aria-hidden /> Imported {result.created.length} card{result.created.length === 1 ? '' : 's'}
          </h3>
          <ul className="card-list">
            {result.created.map((id, i) => (
              <li key={id} className="card-list-row">
                <button type="button" className="card-list-main" onClick={() => openCard(id)}>
                  <span className="card-list-title">{result.items[i]?.card?.title ?? `Card #${id}`}</span>
                  <span className="muted small">
                    #{id} · {result.items[i]?.card?.column.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
