// Accepted-CVE list for the Waltz OSS import (accepted-CVE list plan): a repo file of component + CVE
// pairs the team has decided to live with, applied when the New screen's rows are built. Pure and
// vscode-free; the file IO lives in services/AcceptedListService.ts.

import { vulnRatingRank, type WaltzComponent } from './waltzReport';

export const ACCEPTED_FILE_NAME = '.jira-oss-accepted.json';

export interface AcceptedEntry {
  component: string;
  cve: string;
  reason?: string;
}

export interface ParsedAcceptedFile {
  entries: AcceptedEntry[];
  /** Shown to the user when the file could not be read in full; null when it was fine. */
  warning: string | null;
  /** True when the file is present but not usable at all (invalid JSON or no `accepted` array). */
  unparseable: boolean;
}

/** The component name a `nameVersion` stands for: everything before the last `:` (KTD2). */
export function componentNameOf(nameVersion: string): string {
  const colon = nameVersion.lastIndexOf(':');
  return colon === -1 ? nameVersion : nameVersion.slice(0, colon);
}

const normalizeName = (name: string): string => name.trim().toLowerCase();
const normalizeCve = (cve: string): string => cve.trim().toUpperCase();
const pairKey = (component: string, cve: string): string => `${normalizeName(component)}\u0000${normalizeCve(cve)}`;

/** Reads the file text fail-open (KTD4): a broken file yields no entries and a warning, never a throw. */
export function parseAcceptedFile(text: string): ParsedAcceptedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], warning: `${ACCEPTED_FILE_NAME} is not valid JSON, so no CVEs were hidden. Fix the file and import again.`, unparseable: true };
  }
  const list = (raw as { accepted?: unknown } | null)?.accepted;
  if (!Array.isArray(list)) {
    return { entries: [], warning: `${ACCEPTED_FILE_NAME} has no "accepted" list, so no CVEs were hidden.`, unparseable: true };
  }
  const entries: AcceptedEntry[] = [];
  let skipped = 0;
  for (const item of list) {
    const component = (item as { component?: unknown })?.component;
    const cve = (item as { cve?: unknown })?.cve;
    const reason = (item as { reason?: unknown })?.reason;
    if (typeof component !== 'string' || component.trim() === '' || typeof cve !== 'string' || cve.trim() === '') {
      skipped++;
      continue;
    }
    entries.push(typeof reason === 'string' && reason.trim() !== '' ? { component, cve, reason } : { component, cve });
  }
  return {
    entries,
    warning: skipped > 0 ? `${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ${ACCEPTED_FILE_NAME} had no component or CVE and ${skipped === 1 ? 'was' : 'were'} skipped.` : null,
    unparseable: false,
  };
}

/** Two-space JSON with a trailing newline, like the other repo files this extension writes. */
export function serializeAcceptedFile(entries: AcceptedEntry[]): string {
  return `${JSON.stringify({ accepted: entries }, null, 2)}\n`;
}

/** Appends pairs not already on the list (matched like the importer matches them); `added` counts the new ones. */
export function addAcceptedEntries(existing: AcceptedEntry[], additions: AcceptedEntry[]): { entries: AcceptedEntry[]; added: number } {
  const seen = new Set(existing.map(e => pairKey(e.component, e.cve)));
  const entries = [...existing];
  let added = 0;
  for (const addition of additions) {
    const key = pairKey(addition.component, addition.cve);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(addition);
    added++;
  }
  return { entries, added };
}

/** Removes the entry at a 1-based position (the number `accepted` lists it under); null when there is none. */
export function removeAcceptedEntry(entries: AcceptedEntry[], position: number): { entries: AcceptedEntry[]; removed: AcceptedEntry } | null {
  if (!Number.isInteger(position) || position < 1 || position > entries.length) return null;
  return { entries: entries.filter((_, i) => i !== position - 1), removed: entries[position - 1] };
}

export interface NarrowResult {
  /** The members that remain; null when nothing of the group is left to offer. */
  group: WaltzComponent[] | null;
  /** How many accepted CVEs were taken out of the group. */
  hiddenCves: number;
  /** How many components were hidden only because their recomputed rating fell below the floor (R10). */
  belowFloor: number;
}

/** The highest `overallSeverity` among the CVEs, in the report's casing; null when none carries one (KTD3). */
function highestSeverity(vulns: WaltzComponent['vulnerabilities']): string | null {
  let best: string | null = null;
  for (const v of vulns) {
    if (!v.overallSeverity) continue;
    if (best === null || vulnRatingRank(v.overallSeverity) > vulnRatingRank(best)) best = v.overallSeverity;
  }
  return best;
}

/**
 * Narrows one row's components against the accepted list (R3, R4, R10). A component that lost no CVE
 * is kept exactly as it came, with its report rating and no floor check (KTD3); one that lost every
 * CVE is dropped; one that lost some is rated by what is left and dropped when that is below the floor.
 */
export function narrowGroup(group: WaltzComponent[], entries: AcceptedEntry[], minRating: string): NarrowResult {
  if (entries.length === 0) return { group, hiddenCves: 0, belowFloor: 0 };
  const accepted = new Set(entries.map(e => pairKey(e.component, e.cve)));
  const floor = vulnRatingRank(minRating);
  const kept: WaltzComponent[] = [];
  let hiddenCves = 0;
  let belowFloor = 0;
  let changed = false;
  for (const c of group) {
    const name = componentNameOf(c.nameVersion);
    const remaining = c.vulnerabilities.filter(v => !accepted.has(pairKey(name, v.cveId)));
    const removed = c.vulnerabilities.length - remaining.length;
    if (removed === 0) {
      kept.push(c);
      continue;
    }
    changed = true;
    hiddenCves += removed;
    if (remaining.length === 0) continue;
    const rating = highestSeverity(remaining) ?? c.maxVulnRating;
    if (vulnRatingRank(rating) < floor) {
      belowFloor++;
      continue;
    }
    kept.push({ ...c, maxVulnRating: rating, vulnerabilities: remaining });
  }
  if (!changed) return { group, hiddenCves: 0, belowFloor: 0 };
  return { group: kept.length > 0 ? kept : null, hiddenCves, belowFloor };
}

/** The entries accepting a row writes: one per CVE of every member, by component name, each CVE once (R5). */
export function acceptedEntriesOf(group: WaltzComponent[], reason?: string): AcceptedEntry[] {
  const seen = new Set<string>();
  const entries: AcceptedEntry[] = [];
  for (const c of group) {
    const component = componentNameOf(c.nameVersion);
    for (const v of c.vulnerabilities) {
      const key = pairKey(component, v.cveId);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(reason ? { component, cve: v.cveId, reason } : { component, cve: v.cveId });
    }
  }
  return entries;
}
