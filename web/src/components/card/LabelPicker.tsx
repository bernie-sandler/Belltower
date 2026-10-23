import type { CardDetail, Label } from '@tt/shared';
import { Check, Settings2 } from 'lucide-react';
import { useUpdateCard } from '../../api/cards';
import { Popover } from '../common/Popover';
import { LabelChip } from '../labels/LabelChip';

interface Props {
  card: CardDetail;
  labels: Label[];
  anchor: HTMLElement;
  onClose: () => void;
  onManage: () => void;
}

/** Toggle labels on a card; each toggle PATCHes labelIds (shown optimistically). */
export function LabelPicker({ card, labels, anchor, onClose, onManage }: Props) {
  const update = useUpdateCard(card.id);

  function toggle(id: number) {
    const next = card.labelIds.includes(id) ? card.labelIds.filter((x) => x !== id) : [...card.labelIds, id];
    update.mutate({ labelIds: next });
  }

  return (
    <Popover anchor={anchor} onClose={onClose} className="label-picker" role="dialog" ariaLabel="Labels" placement="bottom-start">
      <div className="popover-title">Labels</div>
      {labels.length === 0 ? (
        <p className="muted popover-empty">No labels yet.</p>
      ) : (
        <ul className="label-options">
          {labels.map((l) => {
            const on = card.labelIds.includes(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="label-option"
                  onClick={() => toggle(l.id)}
                >
                  <span className="label-option-check" aria-hidden>
                    {on && <Check size={14} />}
                  </span>
                  <LabelChip label={l} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className="btn btn-subtle btn-block"
        onClick={() => {
          onClose();
          onManage();
        }}
      >
        <Settings2 size={16} aria-hidden /> Manage labels…
      </button>
    </Popover>
  );
}
