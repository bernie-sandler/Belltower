// Import cards (/import): paste the JSON an AI produced (or load a .json file), preview exactly
// what will be created, then import. "Copy AI prompt" gives the AI the format and your real
// column and label names.

import type { ImportPreview } from '@tt/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, ClipboardCopy, FileUp, Sparkles, Upload, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { sortedColumns, useBoard } from '../../api/board';
import { api, isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { qk } from '../../api/keys';
import { buildAiPrompt } from '../../lib/aiPrompt';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { useOpenCard } from '../../lib/navigation';
import { todayLocal } from '../../lib/time';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { ImportPreviewList } from './ImportPreview';

const DRAFT = 'import:cards';

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
  const [result, setResult] = useState<ImportPreview | null>(null);
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
    mutationFn: (dryRun: boolean) => api.post<ImportPreview>('/api/import/cards', { text, dryRun }),
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
        if (isApiError(err, 'validation') && (err.body as { result?: ImportPreview })?.result) {
          setResult((err.body as { result: ImportPreview }).result);
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
          <ImportPreviewList items={items} />
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
