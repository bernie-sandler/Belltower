/** Joins truthy class names: cls('a', cond && 'b') → 'a b'. */
export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}
