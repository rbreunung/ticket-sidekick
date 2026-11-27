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

/** The prefix of a sort column id that names a configured extra column: `extra:<field id>`. */
export const EXTRA_COLUMN_PREFIX = 'extra:';

/** The field id a sort column id names, or null when it is not an extra column. */
export function extraColumnId(column: string): string | null {
  return column.startsWith(EXTRA_COLUMN_PREFIX) ? column.slice(EXTRA_COLUMN_PREFIX.length) : null;
}

/** A sort column that sorts as natural text with empty values last: Assignee and the configured extra columns. */
export type NaturalColumn = 'assignee' | `extra:${string}`;

export function isNaturalColumn(column: string): column is NaturalColumn {
  return column === 'assignee' || extraColumnId(column) !== null;
}

/** The sort after a click on a column title: a new column sorts ascending, a second click turns the order around, a third takes the sort off. */
export function nextSort<C extends string>(current: { column: C; descending: boolean } | null | undefined, column: C): { column: C; descending: boolean } | null {
  if (!current || current.column !== column) return { column, descending: false };
  return current.descending ? null : { column, descending: true };
}

/** A sorted copy; values that compare equal keep their original order. */
export function sortNatural<T>(items: readonly T[], valueOf: (item: T) => string | null | undefined, descending: boolean): T[] {
  return [...items].sort((x, y) => compareNatural(valueOf(x), valueOf(y), descending));
}
