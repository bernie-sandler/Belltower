import { LIMITS, type Column } from '@tt/shared';
import { ArrowLeft, ArrowRight, CircleCheck, Ellipsis, Inbox, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRenameColumn, useReorderColumns } from '../../api/columns';
import { Menu } from '../common/Menu';
import { DeleteColumnDialog } from './DeleteColumnDialog';

interface Props {
  column: Column;
  /** All columns, sorted left to right. */
  columns: Column[];
  index: number;
  cardCount: number;
  nameId: string;
}

const ROLE_INFO = {
  triage: { icon: Inbox, title: 'Triage column: new cards land here', reason: "The Triage column can't be deleted" },
  done: { icon: CircleCheck, title: 'Done column: cards here count as completed', reason: "The Done column can't be deleted" },
} as const;

export function ColumnHeader({ column, columns, index, cardCount, nameId }: Props) {
  const rename = useRenameColumn();
  const reorder = useReorderColumns();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);

  const role = column.role ? ROLE_INFO[column.role] : null;
  // Set once the edit is resolved (saved or cancelled): the blur fired as the input unmounts must
  // not save again, and above all must not save text the user just cancelled with Esc.
  const resolved = useRef(false);
  const nameButton = useRef<HTMLButtonElement>(null);
  const refocusName = useRef(false);

  // Return focus to the name after editing ends from the keyboard.
  useEffect(() => {
    if (!editing && refocusName.current) {
      refocusName.current = false;
      nameButton.current?.focus();
    }
  }, [editing]);

  function startEdit() {
    resolved.current = false;
    setDraft(column.name);
    setEditing(true);
  }

  function finish(save: boolean, refocus: boolean) {
    if (resolved.current) return;
    resolved.current = true;
    refocusName.current = refocus;
    setEditing(false);
    const name = draft.trim();
    if (save && name && name !== column.name) rename.mutate({ id: column.id, name });
  }

  function move(delta: -1 | 1) {
    const ids = columns.map((c) => c.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  }

  return (
    <header className="column-header">
      {editing ? (
        <input
          className="input column-name-input"
          aria-label="Column name"
          value={draft}
          maxLength={LIMITS.columnName}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true, true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation(); // Esc cancels the rename only, not an outer layer
              finish(false, true);
            }
          }}
          onBlur={() => finish(true, false)}
        />
      ) : (
        <button
          ref={nameButton}
          type="button"
          id={nameId}
          className="column-name"
          onClick={startEdit}
          title="Click to rename"
        >
          {column.name}
        </button>
      )}
      {role && (
        <span className="column-role" title={role.title}>
          <role.icon size={14} aria-hidden />
          <span className="visually-hidden">{role.title}</span>
        </span>
      )}
      <span className="column-count" title={`${cardCount} card${cardCount === 1 ? '' : 's'}`}>
        {cardCount}
      </span>
      <button
        type="button"
        className="icon-btn column-menu-btn"
        aria-label={`Actions for column “${column.name}”`}
        aria-haspopup="menu"
        aria-expanded={menuAnchor !== null}
        onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
      >
        <Ellipsis size={18} aria-hidden />
      </button>

      {menuAnchor && (
        <Menu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          label={`Column “${column.name}”`}
          items={[
            { key: 'rename', label: 'Rename', icon: <Pencil size={16} />, onSelect: startEdit },
            {
              key: 'left',
              label: 'Move left',
              icon: <ArrowLeft size={16} />,
              disabled: index === 0,
              onSelect: () => move(-1),
            },
            {
              key: 'right',
              label: 'Move right',
              icon: <ArrowRight size={16} />,
              disabled: index === columns.length - 1,
              onSelect: () => move(1),
            },
            'separator',
            {
              key: 'delete',
              label: 'Delete…',
              icon: <Trash2 size={16} />,
              danger: true,
              disabled: role !== null,
              hint: role?.reason,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      )}

      {deleting && (
        <DeleteColumnDialog column={column} columns={columns} cardCount={cardCount} onClose={() => setDeleting(false)} />
      )}
    </header>
  );
}
