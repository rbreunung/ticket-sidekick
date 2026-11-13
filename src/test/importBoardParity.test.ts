import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IMPORT_COMMAND_ENTRIES } from '../participant/sessionState';

// Guard for the import board parity ledger in docs/architecture/migration-status.md: every reply command of the
// `@jira` import review screens and every optional importer capability must have a row there saying whether the
// import board carries it over or drops it. A feature added to the participant import without a ledger row fails here,
// so the board is not planned from a list that misses it.
// See docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md.
// Remove this test together with the import participant (O11).

const root = process.cwd();
const read = (file: string): string => readFileSync(resolve(root, file), 'utf-8');

/** The text of the ledger section, from its heading up to the next heading of the same or a higher level. */
function ledgerSection(): string {
  const doc = read('docs/architecture/migration-status.md');
  const start = doc.indexOf('#### Import board parity ledger');
  expect(start, 'migration-status.md has an "Import board parity ledger" section').toBeGreaterThanOrEqual(0);
  const rest = doc.slice(doc.indexOf('\n', start) + 1);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The names in code spans in the first cell of each ledger row, with the row's second cell (the decision). */
function ledgerRows(section: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 4 || cells[1].startsWith('---')) continue;
    for (const m of cells[1].matchAll(/`([^`]+)`/g)) rows.set(m[1], cells[2]);
  }
  return rows;
}

/** The optional members declared directly on an exported interface (two-space indentation; nested members are skipped). */
function optionalMembers(source: string, iface: string): string[] {
  const start = source.indexOf(`export interface ${iface}`);
  expect(start, `${iface} is declared`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\?(?::|\()/gm)].map(m => m[1]);
}

const DECISIONS = ['Carry over', 'Dropped'];

describe('import board parity ledger', () => {
  const rows = ledgerRows(ledgerSection());

  it('lists every reply command of the import review screens', () => {
    const missing = IMPORT_COMMAND_ENTRIES.map(e => e.id).filter(id => !rows.has(id));
    expect(missing, 'commands with no row in the import board parity ledger').toEqual([]);
  });

  it('lists every optional capability an importer can supply', () => {
    const types = read('src/participant/jira/reportImportTypes.ts');
    const capabilities = [
      ...optionalMembers(types, 'ReportImportDescriptor'),
      ...optionalMembers(types, 'ImportChangeTracking'),
    ];
    expect(capabilities.length, 'capabilities were found in reportImportTypes.ts').toBeGreaterThan(10);
    const missing = capabilities.filter(name => !rows.has(name));
    expect(missing, 'capabilities with no row in the import board parity ledger').toEqual([]);
  });

  it('gives every row a decision', () => {
    const undecided = [...rows].filter(([, decision]) => !DECISIONS.includes(decision)).map(([name]) => name);
    expect(undecided, `rows whose decision is not one of ${DECISIONS.join(' / ')}`).toEqual([]);
  });
});
