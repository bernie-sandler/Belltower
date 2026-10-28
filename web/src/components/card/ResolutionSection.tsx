// On a done card: how it was resolved (reason + Markdown note), with Edit; or "Add resolution"
// when it was dragged into Done without one.

import type { CardDetail } from '@tt/shared';
import { CircleCheck, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '../common/Markdown';
import { ResolveDialog } from './ResolveDialog';

export function ResolutionSection({ card, readOnly }: { card: CardDetail; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="card-section resolution" aria-labelledby="card-resolution-heading">
      <h3 id="card-resolution-heading" className="card-section-title">
        <CircleCheck size={16} aria-hidden /> Resolution
      </h3>
      {card.resolution ? (
        <div className="resolution-view">
          <div className="resolution-head">
            <span className="badge resolution-badge">{card.resolution}</span>
            {!readOnly && (
              <button type="button" className="btn btn-sm btn-subtle" onClick={() => setEditing(true)}>
                <Pencil size={14} aria-hidden /> Edit
              </button>
            )}
          </div>
          {card.resolutionNote && <Markdown text={card.resolutionNote} className="description-text resolution-text" />}
        </div>
      ) : (
        !readOnly && (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            <Plus size={14} aria-hidden /> Add resolution
          </button>
        )
      )}
      {editing && <ResolveDialog cardId={card.id} mode="edit" onClose={() => setEditing(false)} />}
    </section>
  );
}
