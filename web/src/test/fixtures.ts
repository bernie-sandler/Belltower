// Small builders for the shapes the board works with.
import type { BoardResponse, CardTile, Column } from '@tt/shared';

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
    blockedBy: 0,
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
