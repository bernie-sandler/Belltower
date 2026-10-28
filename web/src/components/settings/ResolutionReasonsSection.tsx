// Resolution reasons offered on Mark done. The first is the default; cards keep the text they were
// resolved with, so renaming or removing a reason never rewrites history.

import { DEFAULT_RESOLUTION_REASONS, type SettingsResponse } from '@tt/shared';
import { ArrowUp, CircleCheck, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useSaveResolutions } from '../../api/settings';
import { toast } from '../../lib/toast';
import { Section } from './SettingsPage';

const MAX = 12;

export function ResolutionReasonsSection({ s }: { s: SettingsResponse }) {
  const save = useSaveResolutions();
  const [reasons, setReasons] = useState<string[]>(s.resolutionReasons);
  const [error, setError] = useState<string | null>(null);
  const clean = reasons.map((r) => r.trim()).filter(Boolean);
  const dirty = clean.join('\n') !== s.resolutionReasons.join('\n');

  const set = (i: number, v: string) => setReasons((rs) => rs.map((r, j) => (j === i ? v : r)));
  const remove = (i: number) => setReasons((rs) => rs.filter((_, j) => j !== i));
  const up = (i: number) => setReasons((rs) => (i === 0 ? rs : [...rs.slice(0, i - 1), rs[i]!, rs[i - 1]!, ...rs.slice(i + 1)]));

  return (
    <Section icon={<CircleCheck size={16} aria-hidden />} title="Resolution reasons">
      <p className="field-help">Offered when you mark a card done. The first one is the default.</p>
      <ol className="reason-list">
        {reasons.map((r, i) => (
          <li key={i} className="reason-row">
            <input
              className="input"
              value={r}
              maxLength={40}
              aria-label={`Reason ${i + 1}${i === 0 ? ' (default)' : ''}`}
              onChange={(e) => set(i, e.target.value)}
            />
            {i === 0 ? (
              <span className="tag">Default</span>
            ) : (
              <button type="button" className="icon-btn" aria-label={`Move “${r}” up`} title="Move up" onClick={() => up(i)}>
                <ArrowUp size={16} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove “${r}”`}
              title="Remove"
              disabled={reasons.length <= 1}
              onClick={() => remove(i)}
            >
              <X size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="button" className="btn" disabled={reasons.length >= MAX} onClick={() => setReasons((rs) => [...rs, ''])}>
          <Plus size={16} aria-hidden /> Add reason
        </button>
        <button type="button" className="btn btn-subtle" onClick={() => setReasons([...DEFAULT_RESOLUTION_REASONS])}>
          Reset to defaults
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || clean.length === 0 || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate(
              { reasons: clean },
              {
                onSuccess: (res) => {
                  setReasons(res.resolutionReasons);
                  toast('Saved', { kind: 'success', durationMs: 2000 });
                },
                onError: (err) => setError(errorMessage(err)),
              },
            );
          }}
        >
          Save
        </button>
      </div>
    </Section>
  );
}
