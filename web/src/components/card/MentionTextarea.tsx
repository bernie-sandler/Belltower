// A work-log textarea with @ autocomplete: type @ and part of a name, then pick someone with the
// arrow keys and Enter (or Tab), or tap them. Esc closes the list and leaves the text alone. The
// list sits under the field rather than at the caret, so it works the same on phones.
//
// ARIA: the textarea keeps its textbox role, with aria-autocomplete="list" and aria-controls
// pointing at the listbox; the highlighted option is announced through aria-activedescendant
// while focus stays in the text, and a live region says how many people match.

import type { UserRef } from '@tt/shared';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react';
import { cls } from '../../lib/cls';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

/** At most this many suggestions. */
const MAX_SUGGESTIONS = 6;

/** The character before an @ that makes it part of something else (an email, a URL), as in findMentions. */
const NOT_BEFORE_MENTION = /[\p{L}\p{N}._+\-/@\\]/u;

/** The @word being typed at the caret: where its @ is and what follows it (possibly nothing yet). */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /@([A-Za-z0-9._-]{0,32})$/.exec(text.slice(Math.max(0, caret - 34), caret));
  if (!m) return null;
  const start = caret - m[0].length;
  if (start > 0 && NOT_BEFORE_MENTION.test(text[start - 1]!)) return null;
  // Inside inline code (an odd number of backticks before it on this line) it's just text.
  const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  return { start, query: m[1]! };
}

/** Active people whose username or a word of their name starts with `query`; usernames first. */
export function matchPeople<T extends Pick<UserRef, 'username' | 'displayName' | 'disabled'>>(people: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const byUsername: T[] = [];
  const byName: T[] = [];
  for (const p of people) {
    if (p.disabled) continue;
    if (p.username.toLowerCase().startsWith(q)) byUsername.push(p);
    else if (p.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) byName.push(p);
  }
  return [...byUsername, ...byName].slice(0, MAX_SUGGESTIONS);
}

type Props = Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  people: readonly UserRef[];
};

export function MentionTextarea({ value, onValueChange, people, onKeyDown, ref, className, ...rest }: Props) {
  const listId = useId();
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  /** The @ position the person closed the list for with Esc (it stays closed for that word). */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  const token = caret === null ? null : mentionQueryAt(value, caret);
  const suggestions = token && token.start !== dismissed ? matchPeople(people, token.query) : [];
  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));

  // Put the caret after a picked name once React has written the new value.
  useLayoutEffect(() => {
    const el = inner.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function trackCaret() {
    const el = inner.current;
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  }

  function pick(username: string) {
    if (!token || caret === null) return;
    const insert = `@${username} `;
    const after = value.slice(caret).replace(/^[A-Za-z0-9._-]*/, ''); // the rest of a name typed in the middle
    pendingCaret.current = token.start + insert.length;
    onValueChange(value.slice(0, token.start) + insert + after.replace(/^ /, ''));
    setActive(0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[activeIndex]!.username);
        return;
      }
      if (e.key === 'Escape') {
        // Ours: the card (or dialog) underneath stays open.
        e.preventDefault();
        setDismissed(token!.start);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="mention-field">
      <AutoGrowTextarea
        {...rest}
        ref={setRefs}
        className={className}
        value={value}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart === e.target.selectionEnd ? e.target.selectionStart : null);
          setActive(0);
        }}
        onSelect={trackCaret}
        onClick={trackCaret}
        onBlur={() => setCaret(null)}
        onKeyDown={handleKeyDown}
      />
      <span className="visually-hidden" aria-live="polite">
        {open ? `${suggestions.length} ${suggestions.length === 1 ? 'person' : 'people'} to mention; arrow keys to choose, Enter to pick` : ''}
      </span>
      {open && (
        <ul className="mention-list" id={listId} role="listbox" aria-label="People to mention">
          {suggestions.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={cls('mention-option', i === activeIndex && 'is-active')}
              // Keep focus (and the caret) in the text field.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(p.username)}
            >
              <span className="mention-option-name">{p.displayName}</span>
              <span className="mention-option-user">@{p.username}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
