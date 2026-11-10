// Small builders for the shapes the board works with.
import type { BoardResponse, CardDetail, CardTile, ChecklistItem, ChecklistItemState, Column } from '@tt/shared';

let nextId = 1;

export function tile(over: Partial<CardTile> = {}): CardTile {
  const id = over.id ?? nextId++;
  return {
    id,
    ticketNo: `261027-${id}`,
    kind: 'ticket',
    parentId: null,
    childCount: 0,
    childOpen: 0,
    resolution: null,
    columnId: 1,
    title: `Card ${id}`,
    position: id,
    priority: null,
    severity: null,
    dueDate: null,
    dueTime: null,
    completedAt: null,
    labelIds: [],
    attachmentCount: 0,
    linkCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    checklistFailed: 0,
    checklistUnverified: 0,
    blockedBy: 0,
    assigneeId: null,
    version: 1,
    ...over,
  };
}

export const COLUMNS: Column[] = [
  { id: 1, name: 'Triage', position: 0, role: 'triage' },
  { id: 2, name: 'In Progress', position: 1, role: null },
  { id: 3, name: 'Done', position: 2, role: 'done' },
];

export function board(cards: CardTile[]): BoardResponse {
  return { columns: COLUMNS, labels: [], cards, blockedColumnId: null, resolutionReasons: ['Fixed', 'Won’t fix'] };
}

export function checklistItem(id: number, state: ChecklistItemState = 'open', text = `Item ${id}`): ChecklistItem {
  return { id, text, state, checked: state === 'done', checkedAt: null, position: id };
}

/** A card with one checklist holding `items`. Only checklistTotal is filled in; set the other counts via `over`. */
export function cardDetail(items: ChecklistItem[], over: Partial<CardDetail> = {}): CardDetail {
  return {
    ...tile({ checklistTotal: items.length }),
    description: '',
    archivedAt: null,
    deletedAt: null,
    source: 'manual',
    createdAt: '2026-10-27T15:00:00.000Z',
    updatedAt: '2026-10-27T15:00:00.000Z',
    checklists: [{ id: 1, title: 'Checklist', position: 0, items }],
    attachments: [],
    links: [],
    parent: null,
    children: [],
    resolutionNote: '',
    watching: false,
    ...over,
  };
}
