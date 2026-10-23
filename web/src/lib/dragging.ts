// Global "a drag is in progress" flag. Read by the keyboard handler (shortcuts are ignored while
// dragging), by TanStack Query (no refetch-on-focus mid-drag) and by tiles (ignore the click that
// can follow a drop or a cancelled drag).

let dragging = false;
let pointerDrag = false;
let lastDragEnd = 0;
/** Set when a mouse/touch drag ends; cleared by the next pointer press (a fresh interaction). */
let suppressClick = false;
let listening = false;

function onPointerDown(): void {
  suppressClick = false;
}

/** `viaPointer`: the drag was started by mouse or touch (not the keyboard). */
export function setDragging(value: boolean, viaPointer = true): void {
  if (value && !dragging) pointerDrag = viaPointer;
  if (dragging && !value) {
    lastDragEnd = Date.now();
    if (pointerDrag) {
      suppressClick = true;
      if (!listening && typeof document !== 'undefined') {
        listening = true;
        // Capture phase: runs before anything on the page sees the press.
        document.addEventListener('pointerdown', onPointerDown, true);
      }
    }
  }
  dragging = value;
}

export function isDragging(): boolean {
  return dragging;
}

/**
 * True during a drag and right after one, so the click some browsers fire on release (including
 * after Esc cancelled a drag while the button was still held) doesn't open the card.
 */
export function justDropped(): boolean {
  return dragging || suppressClick || Date.now() - lastDragEnd < 250;
}
