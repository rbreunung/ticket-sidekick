import type { JiraFilter } from '../jira/IJiraClient';

/**
 * Jira's built-in system filters, the negative ids its issue search knows (`/issues/?filter=-1`).
 * They are not saved filters: Jira's REST API cannot read them and JQL's `filter = -1` refuses
 * them, so Ticket Sidekick runs this JQL for them instead. The queries follow Jira's own
 * definitions as far as they are known here; check them against your Jira and tune them here.
 */
export const SYSTEM_FILTERS: readonly JiraFilter[] = [
  { id: '-1', name: 'My open issues', jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC' },
  { id: '-2', name: 'Reported by me', jql: 'reporter = currentUser() ORDER BY created DESC' },
  { id: '-3', name: 'Viewed recently', jql: 'issuekey in issueHistory() ORDER BY lastViewed DESC' },
  { id: '-4', name: 'All issues', jql: 'ORDER BY created DESC' },
  { id: '-5', name: 'Open issues', jql: 'resolution = Unresolved ORDER BY priority DESC, updated DESC' },
  { id: '-6', name: 'Created recently', jql: 'created >= -1w ORDER BY created DESC' },
  { id: '-7', name: 'Resolved recently', jql: 'resolutiondate >= -1w ORDER BY updated DESC' },
  { id: '-8', name: 'Updated recently', jql: 'updated >= -1w ORDER BY updated DESC' },
  { id: '-9', name: 'Done issues', jql: 'statusCategory = Done ORDER BY updated DESC' },
].map(f => ({ ...f, system: true }));

/** A filter id as Jira writes it: a saved filter's positive number, or a system filter's negative one. */
export const FILTER_ID_PATTERN = /^-?\d+$/;

export function isSystemFilterId(id: string): boolean {
  return /^-\d+$/.test(id.trim());
}

/** The system filter with this id, or undefined. */
export function systemFilterById(id: string): JiraFilter | undefined {
  return SYSTEM_FILTERS.find(f => f.id === id.trim());
}

/** The system filter called exactly this (any case, spaces collapsed), or undefined. */
export function systemFilterByName(name: string): JiraFilter | undefined {
  const wanted = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return SYSTEM_FILTERS.find(f => f.name.toLowerCase() === wanted);
}
