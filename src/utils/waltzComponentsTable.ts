// The components table every Waltz ticket description carries (one row per component, single-component
// tickets included) and the reader that turns a ticket's text back into per-component records. Pure and
// vscode-free. The column titles are shared with the builder (waltzReport.ts) through waltzDates.ts, and a
// round-trip test builds a description and reads it back.
//
// Component names, remediation actions and plan statuses went through the import's cell sanitizer, so
// they are returned as the ticket holds them and marked approximate. Ratings from the rating label and
// the dates (exact `YYYY-MM-DD` cells) are exact.
import { readWikiTables, normalizeTitle } from './wikiTableRead';
import {
  ABSENT_CELL, COLUMN_ACTION, COLUMN_ARTIFACTS, COLUMN_COMPONENT, COLUMN_CVES, COLUMN_ATTESTATION, COLUMN_PLANNED,
  COLUMN_POLICY, COLUMN_RATING, COLUMN_STATUS, cellDate,
} from './waltzDates';

export type ComponentDetailSource = 'table' | 'legacy' | 'title-labels';

export interface TicketComponent {
  /** Name and version, e.g. `netty-codec:4.1.100`; null when the text no longer names it. */
  nameVersion: string | null;
  rating: string | null;
  remediationAction: string | null;
  cveCount: number | null;
  artifactCount: number | null;
  policyDate: string | null;
  plannedDate: string | null;
  attestationDate: string | null;
  planStatus: string | null;
  /** True when a text field may differ from the report because of sanitizing. */
  approximate: boolean;
  detailSource: ComponentDetailSource;
}

export interface ReadComponentsResult {
  components: TicketComponent[];
  detailSource: ComponentDetailSource;
  /** The ticket carries a different number of component labels than the text lists components: it was edited. */
  edited: boolean;
}

export interface WaltzTicketTextContext {
  summary: string | null;
  labels: string[];
}

const COMPONENT_LABEL_PREFIX = 'oss-dep-';
const RATING_LABEL_PREFIX = 'oss-rating-';

function cellOrNull(cell: string | undefined): string | null {
  const text = (cell ?? '').trim();
  return text === '' || text === ABSENT_CELL ? null : text;
}

function countOrNull(cell: string | undefined): number | null {
  const text = (cell ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function indexOfTitle(titles: string[], name: string): number {
  return titles.indexOf(normalizeTitle(name));
}

/** The rating and, for a one-component ticket, the name from a `[OSS] <name> — <rating>` title. */
function readTitle(summary: string | null): { name: string | null; rating: string | null; folded: boolean } {
  const match = /^\[OSS\]\s+(.+?)(?:\s+\+\d+\s+components?)?\s+—\s+(.+)$/.exec(summary ?? '');
  if (!match) return { name: null, rating: null, folded: false };
  return { name: match[1], rating: match[2].trim(), folded: / \+\d+ components? — /.test(summary ?? '') };
}

function ratingFromLabels(labels: string[]): string | null {
  const label = labels.find(l => l.startsWith(RATING_LABEL_PREFIX));
  return label ? label.slice(RATING_LABEL_PREFIX.length) : null;
}

function fromTable(titles: string[], rows: string[][], hasActionColumn: boolean): TicketComponent[] {
  const at = {
    name: indexOfTitle(titles, COLUMN_COMPONENT),
    rating: indexOfTitle(titles, COLUMN_RATING),
    action: indexOfTitle(titles, COLUMN_ACTION),
    cves: indexOfTitle(titles, COLUMN_CVES),
    artifacts: indexOfTitle(titles, COLUMN_ARTIFACTS),
    policy: indexOfTitle(titles, COLUMN_POLICY),
    planned: indexOfTitle(titles, COLUMN_PLANNED),
    attestation: indexOfTitle(titles, COLUMN_ATTESTATION),
    status: indexOfTitle(titles, COLUMN_STATUS),
  };
  return rows
    .filter(r => cellOrNull(r[at.name]) !== null)
    .map(r => ({
      nameVersion: cellOrNull(r[at.name]),
      rating: cellOrNull(r[at.rating]),
      remediationAction: cellOrNull(r[at.action]),
      cveCount: countOrNull(r[at.cves]),
      artifactCount: countOrNull(r[at.artifacts]),
      policyDate: cellDate(r[at.policy]),
      plannedDate: cellDate(r[at.planned]),
      attestationDate: cellDate(r[at.attestation]),
      planStatus: cellOrNull(r[at.status]),
      approximate: true,
      detailSource: hasActionColumn ? 'table' as const : 'legacy' as const,
    }));
}

/** The older single-component layout: a "Remediation dates" table with no Component column. */
function fromLegacySection(wiki: string, context: WaltzTicketTextContext): TicketComponent[] {
  const title = readTitle(context.summary);
  if (title.name === null) return [];
  const table = readWikiTables(wiki).find(t => indexOfTitle(t.titles, COLUMN_POLICY) >= 0 && indexOfTitle(t.titles, COLUMN_COMPONENT) < 0);
  const row = table?.rows[0];
  // Without that table the description holds nothing beyond the title, which is the last layer's job.
  if (!table || !row) return [];
  const date = (name: string) => cellDate(row[indexOfTitle(table.titles, name)]);
  return [{
    nameVersion: title.name,
    rating: title.rating ?? ratingFromLabels(context.labels),
    remediationAction: null,
    cveCount: null,
    artifactCount: null,
    policyDate: date(COLUMN_POLICY),
    plannedDate: date(COLUMN_PLANNED),
    attestationDate: date(COLUMN_ATTESTATION),
    planStatus: cellOrNull(row[indexOfTitle(table.titles, COLUMN_STATUS)]),
    approximate: true,
    detailSource: 'legacy',
  }];
}

/** The last layer: the first component's name and the rating from the title, the rating from its label. */
function fromTitleAndLabels(context: WaltzTicketTextContext): TicketComponent[] {
  const title = readTitle(context.summary);
  const rating = title.rating ?? ratingFromLabels(context.labels);
  if (title.name === null && rating === null) return [];
  return [{
    nameVersion: title.name,
    rating,
    remediationAction: null,
    cveCount: null,
    artifactCount: null,
    policyDate: null,
    plannedDate: null,
    attestationDate: null,
    planStatus: null,
    approximate: true,
    detailSource: 'title-labels',
  }];
}

/**
 * The per-component records a Waltz ticket's description (Jira wiki text) holds, read in layers: the
 * components table, the older tables and single-component dates section, then the title and labels.
 * Lenient by design: column titles match case-insensitively and in any order, a cell that is not an
 * exact date reads as no date, and nothing here throws.
 */
export function readWaltzComponents(wiki: string | null | undefined, context: WaltzTicketTextContext): ReadComponentsResult {
  const text = wiki ?? '';
  let components: TicketComponent[] = [];

  for (const table of readWikiTables(text)) {
    if (indexOfTitle(table.titles, COLUMN_COMPONENT) < 0 || indexOfTitle(table.titles, COLUMN_RATING) < 0) continue;
    components = fromTable(table.titles, table.rows, indexOfTitle(table.titles, COLUMN_ACTION) >= 0);
    if (components.length > 0) break;
  }
  if (components.length === 0) components = fromLegacySection(text, context);
  if (components.length === 0) components = fromTitleAndLabels(context);

  const labelled = context.labels.filter(l => l.startsWith(COMPONENT_LABEL_PREFIX)).length;
  const edited = components.length > 0 && components[0].detailSource !== 'title-labels' && labelled > 0 && labelled !== components.length;
  const detailSource = components.length === 0 ? 'title-labels' : components.some(c => c.detailSource === 'legacy') ? 'legacy' : components[0].detailSource;
  return { components, detailSource, edited };
}
