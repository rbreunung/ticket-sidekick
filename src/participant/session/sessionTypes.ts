// Session shapes referenced across several session modules, kept in a leaf file so they import nothing.
// Pure (vscode-free); re-exported through ../sessionState.ts.

export interface CommentListSession {
  ticketKey: string;
  comments: Array<{
    index: number;
    author: string;
    date: string;
    bodyMarkdown: string;
  }>;
}

export interface TransitionSubtask {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  resolution?: string;
  extra?: Record<string, unknown>;
  // U6/KTD6: mirrors ReviewRowBase's `included` convention — whether this subtask transitions if
  // the batch runs. Defaults to true at construction (cleanupHandler.ts); toggled per-row (R8) by
  // buildReviewTable()'s Include? column and parseSkipInput()'s cascading toggle.
  included: boolean;
}

export interface TransitionBatchTicket {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  subtasks: TransitionSubtask[];
  extra?: Record<string, unknown>;
  // U6/KTD6: see TransitionSubtask.included above — same convention, same default/toggle path.
  included: boolean;
}

/** U4/R4: a named fixVersion/sprint/assignee constraint extracted alongside a filter reference (or
 * a `listMyFilters` pick) that hasn't been resolved yet — carried across a filter-name-ambiguity
 * detour (FilterSelectionSession/ListedFiltersSession) so the constraint is still applied once the
 * filter itself is chosen. All three are optional/independent; `null` and `undefined` are both
 * "not named" (ParsedIntent fields are `string | null`). */
export interface PendingSearchConstraints {
  fixVersion?: string | null;
  sprint?: string | null;
  assignee?: string | null;
}

export interface LoadSkippedSession {
  ticketKey: string;
  skipped: Array<{
    filename: string;
    content: string;  // Jira download URL
    size: number;
    mimeType: string;
    reason: string;
  }>;
}
