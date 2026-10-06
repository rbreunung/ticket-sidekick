import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  ACCEPTED_FILE_NAME, addAcceptedEntries, parseAcceptedFile, removeAcceptedEntry, removeAcceptedPair, serializeAcceptedFile,
  type AcceptedEntry, type ParsedAcceptedFile,
} from '../utils/waltzAccepted';

export type AcceptedListChange =
  | { ok: true; entries: AcceptedEntry[]; added: number }
  | { ok: false; message: string };

export type AcceptedListRemoval =
  | { ok: true; entries: AcceptedEntry[]; removed: AcceptedEntry }
  | { ok: false; message: string };

/**
 * Reads and writes the accepted-CVE file in the workspace root (accepted-CVE list plan, KTD4). Reading
 * never throws and is fail-open: a broken file shows more findings, never fewer. Writing never
 * overwrites a file it could not read, so a typo in a hand-edited file cannot cost its entries.
 */
export class AcceptedListService {
  constructor(private readonly workspaceRoot: string) {}

  private get filePath(): string {
    return join(this.workspaceRoot, ACCEPTED_FILE_NAME);
  }

  load(): ParsedAcceptedFile {
    if (!existsSync(this.filePath)) return { entries: [], warning: null, unparseable: false };
    try {
      return parseAcceptedFile(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { entries: [], warning: `${ACCEPTED_FILE_NAME} could not be read (${reason}), so no CVEs were hidden.`, unparseable: true };
    }
  }

  add(additions: AcceptedEntry[]): AcceptedListChange {
    const current = this.load();
    if (current.warning) return { ok: false, message: this.unwritableMessage(current.warning) };
    const { entries, added } = addAcceptedEntries(current.entries, additions);
    if (added === 0) return { ok: true, entries, added };
    return this.write(entries, { ok: true, entries, added });
  }

  remove(position: number): AcceptedListRemoval {
    const current = this.load();
    if (current.warning) return { ok: false, message: this.unwritableMessage(current.warning) };
    const result = removeAcceptedEntry(current.entries, position);
    if (!result) return { ok: false, message: `There is no entry ${position} in ${ACCEPTED_FILE_NAME}.` };
    return this.write(result.entries, { ok: true, entries: result.entries, removed: result.removed });
  }

  /** Removes the entry naming this component + CVE, wherever it now sits (a Remove link from an older list). */
  removePair(component: string, cve: string): AcceptedListRemoval {
    const current = this.load();
    if (current.warning) return { ok: false, message: this.unwritableMessage(current.warning) };
    const result = removeAcceptedPair(current.entries, component, cve);
    if (!result) return { ok: false, message: `${component} · ${cve} is not on the accepted list (it may already have been removed).` };
    return this.write(result.entries, { ok: true, entries: result.entries, removed: result.removed });
  }

  private write<T extends AcceptedListChange | AcceptedListRemoval>(entries: AcceptedEntry[], success: T): T | { ok: false; message: string } {
    try {
      writeFileSync(this.filePath, serializeAcceptedFile(entries), 'utf8');
      return success;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Could not write ${ACCEPTED_FILE_NAME}: ${reason}` };
    }
  }

  // A file that could not be read in full (invalid JSON, or entries skipped) is never rewritten: the
  // rewrite would drop whatever the reader could not keep (R6, data-loss review finding).
  private unwritableMessage(warning: string): string {
    return `${warning} The file was left as it is — fix it first.`;
  }
}
