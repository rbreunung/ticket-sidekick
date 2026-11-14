// Whether a status is final: a move there closes the ticket, so a resolution may go with it and a
// board write needs the native confirmation even for one ticket. Jira's own answer is the Done
// status category, kept per project and issue type in the workflow cache; without it (a cache
// written before categories were kept, or no cache at all) a list of usual names decides.
// No `vscode` here.

/** Usual names of final statuses, used when Jira's categories are not known. */
export const FINAL_STATUS_NAMES: ReadonlySet<string> = new Set([
  'done', 'resolved', 'closed', "won't fix", 'wont fix', 'rejected', 'cancelled', 'canceled',
]);

/**
 * `doneStatuses` is the list of status names Jira puts in the Done category for that project and
 * issue type. When it is known it decides alone; otherwise the usual names decide.
 */
export function isFinalStatus(status: string, doneStatuses?: readonly string[]): boolean {
  const name = status.trim().toLowerCase();
  if (doneStatuses && doneStatuses.length > 0) return doneStatuses.some(s => s.trim().toLowerCase() === name);
  return FINAL_STATUS_NAMES.has(name);
}
