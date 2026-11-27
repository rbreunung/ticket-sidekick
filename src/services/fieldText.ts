// How a Jira field value reads as text: for the chat tables and the ticket view (`renderFieldValue`), and as one line of
// plain text in a board cell or export (`renderExtraValue`). Pure and vscode-free.
import type { JiraFieldMeta } from '../jira/IJiraClient';

/** A configured extra column with the description of its field, which rendering needs. */
export interface ColumnWithMeta {
  id: string;
  meta?: JiraFieldMeta;
}

// Jira DC (older) returns sprint values as serialized Java strings rather than JSON objects.
// Both shapes are normalised to { name, state } here.
export function parseSprintItem(item: unknown): { name: string; state: string } | null {
  if (typeof item === 'string') {
    const name = item.match(/\bname=([^,\]]+)/)?.[1]?.trim();
    const state = item.match(/\bstate=([^,\]]+)/)?.[1]?.toLowerCase();
    return name ? { name, state: state ?? '' } : null;
  }
  if (typeof item === 'object' && item !== null && 'name' in item) {
    return item as { name: string; state: string };
  }
  return null;
}

// A ticket can have multiple sprints (past + current); the active one is the one worth showing
// or snapshotting, falling back to the first when none is active. Shared by every sprint-value
// call site in this file (display and template-candidate extraction alike).
export function pickActiveOrFirst<T extends { state: string }>(items: T[]): T | undefined {
  return items.find(s => s.state === 'active') ?? items[0];
}

/** One item of a list field as text: a string as it is, an object by its name, value or display name. */
export function arrayItemText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'object' && item !== null) {
    if ('name' in item) return (item as { name: string }).name;
    if ('value' in item) return (item as { value: string }).value;
    if ('displayName' in item) return (item as { displayName: string }).displayName;
  }
  return String(item);
}

export function renderFieldValue(value: unknown, meta: JiraFieldMeta): string {
  if (value === null || value === undefined) return '_Not set_';

  // Sprint (gh-sprint in custom)
  if (meta.schema.custom?.includes('gh-sprint') && Array.isArray(value)) {
    const sprints = value.map(parseSprintItem).filter(Boolean) as Array<{ name: string; state: string }>;
    const active = pickActiveOrFirst(sprints);
    return active ? active.name : '_None_';
  }

  // User
  if (meta.schema.type === 'user') {
    const u = value as { displayName?: string } | null;
    return u?.displayName ?? '_Unassigned_';
  }

  // Datetime
  if (meta.schema.type === 'datetime' && typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return value;
  }

  // Date
  if (meta.schema.type === 'date' && typeof value === 'string') return value.slice(0, 10);

  // Named objects (status, priority, issuetype, version, …)
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'name' in value) {
    return (value as { name: string }).name;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return '_None_';
    const items = value.map(arrayItemText);
    return items.length > 3
      ? `${items.slice(0, 3).join(', ')} … (+${items.length - 3} more)`
      : items.join(', ');
  }

  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return String(value);
}

/** The longest value a cell keeps, which also keeps every Excel cell far below its 32,767-character limit. */
export const MAX_EXTRA_VALUE_CHARS = 500;
const EMPTY_VALUE_WORDS = new Set(['_Not set_', '_None_', '_Unassigned_']);

/** Whether `renderFieldValue` returned its word for no value rather than a value. */
export function isEmptyRendered(rendered: string): boolean {
  return EMPTY_VALUE_WORDS.has(rendered);
}

/**
 * A field value as one line of plain text for a cell: the same per-type reading as the ticket list, except that a
 * list shows all its items joined with "; ". No value is the raw empty string, never a word like "Not set", so a
 * sort can tell it from a value. Whitespace collapses to single spaces and the text is cut at `MAX_EXTRA_VALUE_CHARS`.
 */
export function renderExtraValue(value: unknown, meta: JiraFieldMeta): string {
  let text: string;
  if (Array.isArray(value) && !meta.schema.custom?.includes('gh-sprint')) {
    text = value.map(arrayItemText).join('; ');
  } else {
    const rendered = renderFieldValue(value, meta);
    text = isEmptyRendered(rendered) ? '' : rendered;
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXTRA_VALUE_CHARS ? text.slice(0, MAX_EXTRA_VALUE_CHARS) : text;
}

/** The configured extra columns' values of one issue's fields as plain text by field id; a column with no field description is left out. */
export function renderedExtras(fields: Record<string, unknown>, columns: readonly ColumnWithMeta[]): Record<string, string> {
  return Object.fromEntries(columns.filter(c => c.meta).map(c => [c.id, renderExtraValue(fields[c.id], c.meta!)]));
}
