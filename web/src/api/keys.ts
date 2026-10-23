/** TanStack Query keys, in one place. */
export const qk = {
  auth: ['auth'] as const,
  config: ['config'] as const,
  board: ['board'] as const,
  cards: ['card'] as const,
  card: (id: number) => ['card', id] as const,
  activities: ['activity'] as const,
  activity: (id: number) => ['activity', id] as const,
  revisions: (activityId: number) => ['revisions', activityId] as const,
  cardLists: ['cardList'] as const,
  cardList: (status: string, q: string) => ['cardList', status, q] as const,
  textPreview: (id: number, mode: string) => ['textPreview', id, mode] as const,
  search: (qs: string) => ['search', qs] as const,
  calendar: (from: string, to: string) => ['calendar', from, to] as const,
  templates: ['templates'] as const,
};
