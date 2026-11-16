// Session shapes referenced across several session modules, kept in a leaf file so they import nothing.
// Pure (vscode-free); re-exported through ../sessionState.ts.

/** U4/R4: a named fixVersion/sprint/assignee constraint extracted alongside a filter reference (or
 * a `listMyFilters` pick) that hasn't been resolved yet — carried across a filter-name-ambiguity
 * detour (FilterSelectionSession/ListedFiltersSession) so the constraint is still applied once the
 * filter itself is chosen. All three are optional/independent; `null` and `undefined` are both
 * "not named" (ParsedIntent fields are `string | null`). */
export type { PendingSearchConstraints } from '../../utils/searchConstraints';

