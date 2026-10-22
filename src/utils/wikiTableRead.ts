// Reading helpers for the Jira wiki tables the importers write into ticket descriptions
// (`||Header||Header||` rows over `|cell|cell|` rows). Shared by the Waltz and Veracode readers so a
// ticket description is read the same way everywhere. Pure and vscode-free.

/** A column title without its parenthetical (e.g. "(as of 2026-01-01)"), lower-cased, for lenient matching. */
export function normalizeTitle(cell: string): string {
  return cell.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The cells of a wiki header row (`||a||b||`), or null when the line is not one. */
export function splitHeaderRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('||')) return null;
  return trimmed.replace(/^\|\|/, '').replace(/\|+$/, '').split('||');
}

/** The trimmed cells of a wiki data row (`|a|b|`), or null when the line is not one. */
export function splitDataRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.startsWith('||')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

/**
 * Every table in a wiki text as its normalized header titles and its data rows, in document order.
 * A table is a header row followed by consecutive data rows.
 */
export function readWikiTables(wiki: string): Array<{ titles: string[]; rows: string[][] }> {
  const lines = wiki.split(/\r?\n/);
  const tables: Array<{ titles: string[]; rows: string[][] }> = [];
  for (let i = 0; i < lines.length; i++) {
    const header = splitHeaderRow(lines[i]);
    if (!header) continue;
    const rows: string[][] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const row = splitDataRow(lines[j]);
      if (!row) break;
      rows.push(row);
    }
    tables.push({ titles: header.map(normalizeTitle), rows });
    i = j - 1;
  }
  return tables;
}
