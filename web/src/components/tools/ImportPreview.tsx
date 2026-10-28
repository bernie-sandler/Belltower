// What an import (or a "Describe several issues" draft) would create, card by card, with its
// errors and warnings. Used by the Import page and the bulk Add ticket dialog.

import { PRIORITY_CODES, SEVERITY_CODES, type ImportPreviewItem, type ImportPreviewRef } from '@tt/shared';
import { AlertTriangle, FolderOpen, XCircle } from 'lucide-react';
import { cls } from '../../lib/cls';
import { formatDue } from '../../lib/time';

const LINK_WORDS = { blocks: 'blocks', blocked_by: 'blocked by', relates: 'related to' } as const;

/** "card 1.2 “Title”" for a card in this import, "261027-1 “Title”" for one on the board. */
function refText(ref: ImportPreviewRef, items: { label: string }[]): string {
  const where = 'batchIndex' in ref ? `card ${items[ref.batchIndex]?.label ?? ''}` : (ref.ticketNo ?? '');
  return `${where} “${ref.title}”`;
}

export function ImportPreviewList({ items }: { items: ImportPreviewItem[] }) {
  return (
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
                {it.card.resolution && ` · resolved: ${it.card.resolution.reason}`}
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
  );
}
