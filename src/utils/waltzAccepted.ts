// Accepted list for the Waltz OSS import: a repo file of component + CVE pairs the team has decided to
// live with (accepted-CVE list plan) and of component + version entries it has accepted as a whole
// (accepted-components plan). Applied when the review's rows are built. Pure and vscode-free; the file IO
// lives in services/AcceptedListService.ts.

import { vulnRatingRank, type WaltzComponent } from './waltzReport';

export const ACCEPTED_FILE_NAME = '.jira-oss-accepted.json';

/** A CVE accepted for a component, whatever its version. */
export interface AcceptedCveEntry {
  component: string;
  cve: string;
  version?: undefined;
  reason?: string;
}

/** One exact component name + version accepted as a whole (KTD1). */
export interface AcceptedComponentEntry {
  component: string;
  version: string;
  cve?: undefined;
  reason?: string;
}

export type AcceptedEntry = AcceptedCveEntry | AcceptedComponentEntry;

export function isComponentEntry(entry: AcceptedEntry): entry is AcceptedComponentEntry {
  return entry.cve === undefined;
}

export function isCveEntry(entry: AcceptedEntry): entry is AcceptedCveEntry {
  return entry.cve !== undefined;
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

/** The version a `nameVersion` stands for: everything after the last `:`, empty when there is none. */
export function componentVersionOf(nameVersion: string): string {
  const colon = nameVersion.lastIndexOf(':');
  return colon === -1 ? '' : nameVersion.slice(colon + 1);
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();
const normalizeCve = (cve: string): string => cve.trim().toUpperCase();
const pairKey = (component: string, cve: string): string => `${normalizeName(component)}\u0000${normalizeCve(cve)}`;
const componentKey = (component: string, version: string): string => `${normalizeName(component)}\u0000\u0000${version.trim().toLowerCase()}`;
const entryKey = (e: AcceptedEntry): string => (isComponentEntry(e) ? componentKey(e.component, e.version) : pairKey(e.component, e.cve));

/** The component + version keys of the component entries on the list. */
export function acceptedComponentKeys(entries: AcceptedEntry[]): Set<string> {
  return new Set(entries.filter(isComponentEntry).map(e => componentKey(e.component, e.version)));
}

/** True when this exact component name + version is accepted as a whole (KTD2). A `nameVersion` with no version never is. */
export function isComponentAccepted(nameVersion: string, keys: Set<string>): boolean {
  const version = componentVersionOf(nameVersion);
  return version !== '' && keys.has(componentKey(componentNameOf(nameVersion), version));
}

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
    const version = (item as { version?: unknown })?.version;
    const reason = (item as { reason?: unknown })?.reason;
    const hasReason = typeof reason === 'string' && reason.trim() !== '';
    // A `cve` key that is present but not a usable string is a mistyped pair; never read it as a whole-component entry.
    if (typeof component !== 'string' || component.trim() === '' || (cve !== undefined && (typeof cve !== 'string' || cve.trim() === ''))) {
      skipped++;
    } else if (typeof cve === 'string' && cve.trim() !== '') {
      // A CVE makes it a pair; a version on it is ignored (KTD1).
      entries.push(hasReason ? { component, cve, reason } : { component, cve });
    } else if (typeof version === 'string' && version.trim() !== '') {
      entries.push(hasReason ? { component, version, reason } : { component, version });
    } else {
      skipped++;
    }
  }
  return {
    entries,
    warning: skipped > 0 ? `${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ${ACCEPTED_FILE_NAME} had no component, or neither a CVE nor a version, and ${skipped === 1 ? 'was' : 'were'} skipped.` : null,
    unparseable: false,
  };
}

/** Two-space JSON with a trailing newline, like the other repo files this extension writes. */
export function serializeAcceptedFile(entries: AcceptedEntry[]): string {
  return `${JSON.stringify({ accepted: entries }, null, 2)}\n`;
}

/** Appends entries not already on the list (matched like the importer matches them); `added` counts the new ones. */
export function addAcceptedEntries(existing: AcceptedEntry[], additions: AcceptedEntry[]): { entries: AcceptedEntry[]; added: number } {
  const seen = new Set(existing.map(entryKey));
  const entries = [...existing];
  let added = 0;
  for (const addition of additions) {
    const key = entryKey(addition);
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

/**
 * Removes the entry for a component + CVE pair wherever it sits (what a Remove link names); null when it
 * is not on the list. A pair a hand edit listed twice is removed in full, so "offered again" stays true.
 */
export function removeAcceptedPair(entries: AcceptedEntry[], component: string, cve: string): { entries: AcceptedEntry[]; removed: AcceptedEntry } | null {
  const key = pairKey(component, cve);
  const isPair = (e: AcceptedEntry): boolean => !isComponentEntry(e) && pairKey(e.component, e.cve) === key;
  const removed = entries.find(isPair);
  return removed ? { entries: entries.filter(e => !isPair(e)), removed } : null;
}

/** Removes the component entry for a name + version wherever it sits (what a component Remove link names); null when it is not on the list. */
export function removeAcceptedComponent(entries: AcceptedEntry[], component: string, version: string): { entries: AcceptedEntry[]; removed: AcceptedEntry } | null {
  const key = componentKey(component, version);
  const isMatch = (e: AcceptedEntry): boolean => isComponentEntry(e) && componentKey(e.component, e.version) === key;
  const removed = entries.find(isMatch);
  return removed ? { entries: entries.filter(e => !isMatch(e)), removed } : null;
}

export interface NarrowResult {
  /** The members that remain; null when nothing of the group is left to offer. */
  group: WaltzComponent[] | null;
  /** How many accepted CVEs were taken out of the group. */
  hiddenCves: number;
  /** How many components were hidden only because their recomputed rating fell below the floor (R10). */
  belowFloor: number;
  /** How many components were dropped because their exact name + version is accepted as a whole. */
  hiddenComponents: number;
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
  if (entries.length === 0) return { group, hiddenCves: 0, belowFloor: 0, hiddenComponents: 0 };
  const accepted = new Set(entries.filter(isCveEntry).map(e => pairKey(e.component, e.cve)));
  const acceptedComponents = acceptedComponentKeys(entries);
  const floor = vulnRatingRank(minRating);
  const kept: WaltzComponent[] = [];
  let hiddenCves = 0;
  let belowFloor = 0;
  let hiddenComponents = 0;
  let changed = false;
  for (const c of group) {
    // A component accepted as a whole goes first: its CVEs and rating are not looked at (KTD3).
    if (isComponentAccepted(c.nameVersion, acceptedComponents)) {
      changed = true;
      hiddenComponents++;
      continue;
    }
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
  if (!changed) return { group, hiddenCves: 0, belowFloor: 0, hiddenComponents: 0 };
  return { group: kept.length > 0 ? kept : null, hiddenCves, belowFloor, hiddenComponents };
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

/** The entries accepting a row's components as a whole: one per member that carries a version (KTD1). */
export function acceptedComponentEntriesOf(group: WaltzComponent[], reason?: string): AcceptedEntry[] {
  const seen = new Set<string>();
  const entries: AcceptedEntry[] = [];
  for (const c of group) {
    const version = componentVersionOf(c.nameVersion);
    if (version === '') continue;
    const component = componentNameOf(c.nameVersion);
    const key = componentKey(component, version);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(reason ? { component, version, reason } : { component, version });
  }
  return entries;
}
