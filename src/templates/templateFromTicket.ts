import type { TemplateFieldCandidate } from '../services/TicketService';
import type { JiraTemplate } from './TemplateService';

// Building a `.jira-templates.json` entry from a reference ticket: the ticket's template-shaped
// fields (TicketService.getTemplateCandidatesFromTicket picks them) become the template's default
// field values, saved under a name no other template has. Pure, so it is tested without Jira.

/** The template: every candidate field with its value as Jira gave it, so it is writable as is. */
export function buildTemplateFromCandidates(name: string, issueType: string, candidates: readonly TemplateFieldCandidate[]): JiraTemplate {
  const defaultFields: Record<string, unknown> = {};
  for (const candidate of candidates) {
    if (candidate.value !== undefined) defaultFields[candidate.id] = candidate.value;
  }
  return { name, issueType, defaultFields };
}

/** `name` when no template has it, else the lowest free `name (N)`, counting from 2; names match exactly. */
export function nextFreeTemplateName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A field value as a person reads it: a `name`, an `id` or a joined list rather than raw JSON,
 * matching the shapes the template documentation shows (`{ name: "High" }`, `[{ name: "Backend" }]`).
 */
export function formatTemplateFieldValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatTemplateFieldValue).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (obj.id !== undefined) return String(obj.id);
    return JSON.stringify(obj);
  }
  return String(value);
}
