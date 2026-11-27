// The extra columns a board shows beyond its own: which configured field ids become columns, and how a field's
// value reads as plain text in a cell. Shared by the security report, the import board's Already ticketed tab, the
// overview exports and the ticket list. Pure and vscode-free; the field names and the log come in as arguments.
import type { JiraFieldMeta } from '../jira/IJiraClient';
import type { DiagLogger } from '../utils/diagTypes';
export { MAX_EXTRA_VALUE_CHARS, renderExtraValue } from './TicketService';

export interface ResolvedColumn {
  id: string;
  /** The field's name in Jira; the id itself for an unknown field a caller chose to keep. */
  name: string;
  /** The field's description, which `renderExtraValue` needs; absent for an unknown id. */
  meta?: JiraFieldMeta;
}

export interface ResolveOptions {
  /** The setting the ids came from, named in the log line for an unknown id. */
  setting: string;
  /** Ids the board already shows as their own column; they are never added a second time. */
  builtIn?: readonly string[];
  /** Keep an unknown id as a column titled with the id, and let a failed field-name read fail the call. */
  keepUnknown?: boolean;
  onDiag?: DiagLogger;
}

/**
 * Turns the configured field ids into columns. Blank, non-text, repeated and built-in ids are ignored; an id Jira
 * does not know is logged once and skipped (or kept, see `keepUnknown`). Field names are read only when an id is
 * left to resolve, and a failure to read them leaves no extra columns and is logged, never thrown.
 */
export async function resolveExtraColumns(
  ids: readonly unknown[] | undefined,
  loadMeta: () => Promise<JiraFieldMeta[]>,
  options: ResolveOptions,
): Promise<ResolvedColumn[]> {
  const builtIn = new Set(options.builtIn ?? []);
  const wanted: string[] = [];
  for (const raw of ids ?? []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id !== '' && !builtIn.has(id) && !wanted.includes(id)) wanted.push(id);
  }
  if (wanted.length === 0) return [];

  let fields: JiraFieldMeta[];
  try {
    fields = await loadMeta();
  } catch (err) {
    if (options.keepUnknown) throw err;
    options.onDiag?.('error', `Extra columns from ${options.setting} left out: the field names could not be read`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const byId = new Map(fields.map(f => [f.id, f]));
  const columns: ResolvedColumn[] = [];
  for (const id of wanted) {
    const meta = byId.get(id);
    if (!meta) options.onDiag?.('warn', `Unrecognized field in ${options.setting}: ${id}`, { fieldId: id });
    if (meta) columns.push({ id, name: meta.name, meta });
    else if (options.keepUnknown) columns.push({ id, name: id });
  }
  return columns;
}
