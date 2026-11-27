// Natural order for the sortable board columns: digit runs compare by their number ("Team 2" before "Team 10"),
// case is ignored, and an empty value comes last in both directions. The locale is fixed so the order does not
// depend on the machine. Pure and vscode-free.

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Empty means no value: null, undefined, or only whitespace. */
export function isEmptySortValue(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Compares two cell values. Descending turns the order of the values around but never moves an empty value
 * to the front, so the caller must not negate this result again.
 */
export function compareNatural(a: string | null | undefined, b: string | null | undefined, descending: boolean): number {
  const emptyA = isEmptySortValue(a);
  const emptyB = isEmptySortValue(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const order = collator.compare((a as string).trim(), (b as string).trim());
  return descending ? -order : order;
}

/** A sorted copy; values that compare equal keep their original order. */
export function sortNatural<T>(items: readonly T[], valueOf: (item: T) => string | null | undefined, descending: boolean): T[] {
  return [...items].sort((x, y) => compareNatural(valueOf(x), valueOf(y), descending));
}
