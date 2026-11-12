import * as fs from 'fs';
import * as path from 'path';
import { isSessionId } from './sessionId';
import type { Session } from './sessionTypes';

// The cache on disk: one JSON file per session in the extension's storage folder for the
// workspace. It is a cache, not a record: Jira, Bitbucket and the report file stay the truth, a
// file that cannot be read is dropped, and nothing here migrates an older format. A session is
// written to a temporary file that is then renamed, so a crash never leaves half a session.

/** A session larger than this is not stored; its board says it will not survive a restart. */
export const MAX_SESSION_BYTES = 20 * 1024 * 1024;

export interface StoredFile {
  session: Session;
  bytes: number;
}

function looksLikeSession(value: unknown): value is Session {
  const s = value as Partial<Session> | null;
  return typeof s === 'object' && s !== null
    && isSessionId(s.id) && typeof s.kind === 'string'
    && Number.isInteger(s.formatVersion) && Number.isInteger(s.revision)
    && typeof s.createdAt === 'number' && typeof s.lastUsedAt === 'number'
    && typeof s.derived === 'object' && s.derived !== null && typeof s.derived.readAt === 'number'
    && Array.isArray(s.conflicts);
}

export class SessionStore {
  constructor(private readonly dir: string, private readonly maxBytes: number = MAX_SESSION_BYTES) {}

  private file(id: string): string {
    if (!isSessionId(id)) throw new Error('Invalid session id.');
    return path.join(this.dir, `${id}.json`);
  }

  /** Writes the session; false when it is over the size limit and was left unstored. */
  async save(session: Session): Promise<boolean> {
    const text = JSON.stringify(session);
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) {
      await this.delete(session.id);
      return false;
    }
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = this.file(session.id);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, text, { mode: 0o600 });
    await fs.promises.rename(temp, target);
    return true;
  }

  /** The stored session, or undefined when there is none or the file is not a session. */
  async load(id: string): Promise<StoredFile | undefined> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file(id), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (looksLikeSession(parsed) && parsed.id === id) return { session: parsed, bytes: Buffer.byteLength(text, 'utf8') };
    } catch {
      // An unreadable file is dropped below.
    }
    await this.delete(id);
    return undefined;
  }

  async delete(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }

  async list(): Promise<StoredFile[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const found: StoredFile[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      if (!isSessionId(id)) continue;
      const stored = await this.load(id);
      if (stored) found.push(stored);
    }
    return found;
  }

  async deleteAll(): Promise<number> {
    const all = await this.list();
    for (const { session } of all) await this.delete(session.id);
    return all.length;
  }

  /** Deletes the sessions not used since `cutoff` (epoch milliseconds) and returns how many. */
  async expire(cutoff: number): Promise<number> {
    let removed = 0;
    for (const { session } of await this.list()) {
      if (session.lastUsedAt < cutoff) {
        await this.delete(session.id);
        removed++;
      }
    }
    return removed;
  }
}
