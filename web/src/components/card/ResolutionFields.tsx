// How a card was resolved: a reason (Settings' list; the first is the default) and an optional
// note. Shared by Mark done, the work-card "complete together" dialog, and editing it later.

import { LIMITS } from '@tt/shared';
import { useBoard } from '../../api/board';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

export interface ResolutionValue {
  reason: string;
  note: string;
}

/** The reasons offered (the board's copy of Settings), with `current` kept if it was renamed away. */
export function useResolutionReasons(current?: string | null): string[] {
  const { data: board } = useBoard();
  const reasons = board?.resolutionReasons?.length ? board.resolutionReasons : ['Fixed'];
  return current && !reasons.includes(current) ? [...reasons, current] : reasons;
}

interface Props {
  value: ResolutionValue;
  onChange: (v: ResolutionValue) => void;
  /** Enter accepts: on a reason (choosing it), or in the note without Shift. */
  onSubmit: (v: ResolutionValue) => void;
  disabled?: boolean;
}

export function ResolutionFields({ value, onChange, onSubmit, disabled }: Props) {
  const reasons = useResolutionReasons(value.reason);
  return (
    <div className="resolution-fields">
      <div className="segmented segmented-sm resolution-reasons" role="radiogroup" aria-label="Resolution">
        {reasons.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={value.reason === r}
            className="segmented-item"
            disabled={disabled}
            onClick={() => onChange({ ...value, reason: r })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              onChange({ ...value, reason: r });
              onSubmit({ ...value, reason: r });
            }}
          >
            {r}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">
          Note <span className="muted">(optional)</span>
        </span>
        <AutoGrowTextarea
          className="input resolution-note"
          rows={2}
          maxLength={LIMITS.description}
          value={value.note}
          disabled={disabled}
          placeholder="What fixed it, or why it was closed"
          onChange={(e) => onChange({ ...value, note: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit(value);
            }
          }}
        />
        <span className="field-help">Enter to save, Shift+Enter for a new line. Markdown works.</span>
      </label>
    </div>
  );
}
