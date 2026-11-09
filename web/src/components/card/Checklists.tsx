// Checklists: named lists of items with a progress bar. Clicking an item cycles its mark (open,
// ✓ done, ✗ failed, ~ unverified) and shows at once; item text edits inline (Enter saves, Esc
// cancels); items reorder via their ⋯ menu (works the same with mouse, touch and keyboard).

import { LIMITS, type CardDetail, type Checklist, type ChecklistItem, type ChecklistItemState } from '@tt/shared';
import { ArrowDown, ArrowUp, Check, Ellipsis, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useChecklistActions } from '../../api/cardParts';
import { countItems, nextState, STATE_LABELS, STATE_SPOKEN } from '../../lib/checkState';
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
  const { done: answered, failed, unverified, total } = countItems([list]);
  const done = answered - failed;
  const share = (n: number) => (total ? (n / total) * 100 : 0);
  const summary = [done > 0 && `${done} done`, failed > 0 && `${failed} failed`, unverified > 0 && `${unverified} unverified`].filter(
    Boolean,
  );
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

      {/* Done and failed both count as answered: green then red. The red bar sits underneath,
          spanning both, so the join is the green bar's rounded end. */}
      <div className={cls('checklist-progress', total > 0 && done === total && 'is-complete')}>
        <span className="checklist-pct" aria-hidden>
          {Math.round(share(answered))}%
        </span>
        <span
          className="progress"
          role="progressbar"
          aria-label={`${list.title} progress`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
          aria-valuetext={`${answered} of ${total}${summary.length ? `: ${summary.join(', ')}` : ''}`}
        >
          {failed > 0 && <span className="progress-bar is-failed" style={{ width: `${share(answered)}%` }} />}
          <span className="progress-bar is-done" style={{ width: `${share(done)}%` }} />
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
    <li className={cls('checklist-item', `is-${item.state}`)}>
      {/* An aria-label rather than visually-hidden text: browsers pad a flex item's text with
          spaces, which would read as "Order battery , failed". */}
      <button
        type="button"
        className="checklist-check"
        disabled={readOnly}
        aria-label={`${item.text}, ${STATE_SPOKEN[item.state]}`}
        title={readOnly ? STATE_LABELS[item.state] : `${STATE_LABELS[item.state]} — click for ${STATE_LABELS[nextState(item.state)]}`}
        onClick={() => actions.cycle(item)}
      >
        <span className="check-box" aria-hidden>
          <StateGlyph state={item.state} />
        </span>
        <span className="checklist-text">{item.text}</span>
      </button>
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

function StateGlyph({ state }: { state: ChecklistItemState }) {
  if (state === 'done') return <Check size={14} strokeWidth={3} />;
  if (state === 'failed') return <X size={14} strokeWidth={3} />;
  if (state === 'unverified') {
    // lucide has no tilde.
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
        <path d="M4 14c2-5 5-5 8-2s6 3 8-2" />
      </svg>
    );
  }
  return null;
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
