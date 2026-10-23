// Checklists: named lists of items with a progress bar. Ticking a box is optimistic; item text
// edits inline (Enter saves, Esc cancels); items reorder via their ⋯ menu (works the same with
// mouse, touch and keyboard).

import { LIMITS, type CardDetail, type Checklist, type ChecklistItem } from '@tt/shared';
import { ArrowDown, ArrowUp, Ellipsis, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useChecklistActions } from '../../api/cardParts';
import { cls } from '../../lib/cls';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Menu } from '../common/Menu';

type Actions = ReturnType<typeof useChecklistActions>;

export function Checklists({
  card,
  readOnly,
  addRequest,
}: {
  card: CardDetail;
  readOnly: boolean;
  /** Bumped by the sidebar's "Checklist" button to open the "new checklist" field. */
  addRequest: number;
}) {
  const actions = useChecklistActions(card.id);
  const [adding, setAdding] = useState(false);
  const seen = useRef(addRequest);
  useEffect(() => {
    if (addRequest !== seen.current) {
      seen.current = addRequest;
      setAdding(true);
    }
  }, [addRequest]);

  if (!card.checklists.length && !adding) return null;

  return (
    <section className="card-section" aria-label="Checklists">
      {card.checklists.map((list) => (
        <ChecklistView key={list.id} list={list} actions={actions} readOnly={readOnly} />
      ))}
      {adding && (
        <InlineInput
          label="Checklist title"
          initial="Checklist"
          submitLabel="Add checklist"
          max={LIMITS.checklistTitle}
          onSubmit={(title) => {
            actions.addList.mutate(title);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function ChecklistView({ list, actions, readOnly }: { list: Checklist; actions: Actions; readOnly: boolean }) {
  const done = list.items.filter((i) => i.checked).length;
  const total = list.items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const [renaming, setRenaming] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="checklist">
      <div className="card-section-head">
        {renaming ? (
          <InlineInput
            label="Checklist title"
            initial={list.title}
            submitLabel="Save"
            max={LIMITS.checklistTitle}
            onSubmit={(title) => {
              if (title !== list.title) actions.renameList.mutate({ id: list.id, title });
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h3 className="card-section-title">
            <ListChecks size={16} aria-hidden />
            {readOnly ? (
              list.title
            ) : (
              <button type="button" className="link-btn checklist-title" onClick={() => setRenaming(true)} title="Rename">
                {list.title}
              </button>
            )}
          </h3>
        )}
        {!readOnly && !renaming && (
          <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>

      <div className="checklist-progress" aria-label={`${done} of ${total} done`}>
        <span className="checklist-pct">{pct}%</span>
        <span className="progress">
          <span className={cls('progress-bar', total > 0 && done === total && 'is-complete')} style={{ width: `${pct}%` }} />
        </span>
      </div>

      <ul className="checklist-items">
        {list.items.map((item, i) => (
          <ItemRow
            key={item.id}
            item={item}
            index={i}
            list={list}
            actions={actions}
            readOnly={readOnly}
          />
        ))}
      </ul>

      {!readOnly &&
        (addingItem ? (
          <InlineInput
            label="New item"
            initial=""
            placeholder="Add an item"
            submitLabel="Add"
            max={LIMITS.checklistItem}
            keepOpen
            onSubmit={(text) => actions.addItem.mutate({ listId: list.id, text })}
            onCancel={() => setAddingItem(false)}
          />
        ) : (
          <button type="button" className="btn btn-sm checklist-add" onClick={() => setAddingItem(true)}>
            <Plus size={14} aria-hidden /> Add an item
          </button>
        ))}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete checklist?"
          message={`“${list.title}” and its ${total} item${total === 1 ? '' : 's'} will be removed. The card's history keeps a note.`}
          danger
          confirmLabel="Delete checklist"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            actions.deleteList.mutate(list.id);
          }}
        />
      )}
    </div>
  );
}

function ItemRow({
  item,
  index,
  list,
  actions,
  readOnly,
}: {
  item: ChecklistItem;
  index: number;
  list: Checklist;
  actions: Actions;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  function move(delta: -1 | 1) {
    const ids = list.items.map((i) => i.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    actions.reorderItems.mutate({ listId: list.id, ids });
  }

  if (editing) {
    return (
      <li className="checklist-item is-editing">
        <InlineInput
          label="Item text"
          initial={item.text}
          submitLabel="Save"
          max={LIMITS.checklistItem}
          onSubmit={(text) => {
            if (text !== item.text) actions.editItem.mutate({ id: item.id, text });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className={cls('checklist-item', item.checked && 'is-checked')}>
      <label className="checklist-check">
        <input
          type="checkbox"
          checked={item.checked}
          disabled={readOnly}
          onChange={(e) => actions.toggle.mutate({ id: item.id, checked: e.target.checked })}
        />
        <span className="checklist-text">{item.text}</span>
      </label>
      {!readOnly && (
        <button
          type="button"
          className="icon-btn checklist-item-menu"
          aria-label={`Actions for “${item.text}”`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => setMenu(menu ? null : e.currentTarget)}
        >
          <Ellipsis size={16} aria-hidden />
        </button>
      )}
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          label={`Item “${item.text}”`}
          items={[
            { key: 'edit', label: 'Edit', icon: <Pencil size={16} />, onSelect: () => setEditing(true) },
            { key: 'up', label: 'Move up', icon: <ArrowUp size={16} />, disabled: index === 0, onSelect: () => move(-1) },
            {
              key: 'down',
              label: 'Move down',
              icon: <ArrowDown size={16} />,
              disabled: index === list.items.length - 1,
              onSelect: () => move(1),
            },
            'separator',
            { key: 'delete', label: 'Delete', icon: <Trash2 size={16} />, danger: true, onSelect: () => actions.deleteItem.mutate(item.id) },
          ]}
        />
      )}
    </li>
  );
}

/** A one-line text field with Save/Cancel; Enter saves, Esc cancels. `keepOpen` for rapid entry. */
export function InlineInput({
  label,
  initial,
  placeholder,
  submitLabel,
  max,
  keepOpen,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  placeholder?: string;
  submitLabel: string;
  max: number;
  keepOpen?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function submit() {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    if (keepOpen) {
      setValue('');
      ref.current?.focus();
    }
  }

  return (
    <form
      className="inline-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={ref}
        className="input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        maxLength={max}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // cancel this field only, not the card
            onCancel();
          }
        }}
      />
      <div className="editor-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={!value.trim()}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {keepOpen ? 'Done' : 'Cancel'}
        </button>
      </div>
    </form>
  );
}
