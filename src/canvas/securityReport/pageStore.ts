import { randomBytes } from 'crypto';
import type { Overview } from '../../utils/securityOverview';

// The Jira readings the open security report pages show, held in memory only, so Save writes the
// reading a page shows and nothing about the report reaches disk unless the developer saves it.
// A reading is dropped after an hour or when more than ten are held; its page then asks for
// Refresh before it saves. When a newer page for the same project opens, the older one is marked
// replaced, so it stops refreshing and saving.

export interface KeptReading {
  pageId: string;
  project: string;
  overview: Overview;
  readAt: Date;
}

export const MAX_KEPT_READINGS = 10;
export const READING_TTL_MS = 60 * 60 * 1000;
/** How many replaced page ids are remembered; an older one reads as current again. */
const MAX_REPLACED_IDS = 200;

export type PageState = 'current' | 'replaced';

export class PageStore {
  private readonly readings = new Map<string, KeptReading>();
  private readonly replaced = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Keeps a new reading for the project and returns its page id. A refresh passes the page's
   * previous id, which is dropped rather than marked replaced, since that page lives on under the
   * new id. Every other page of the project is marked replaced. Returns the ids it replaced.
   */
  add(project: string, overview: Overview, previousPageId?: string): { pageId: string; replaced: string[] } {
    this.prune();
    if (previousPageId) this.readings.delete(previousPageId);
    const replaced: string[] = [];
    for (const reading of [...this.readings.values()]) {
      if (reading.project !== project) continue;
      this.readings.delete(reading.pageId);
      this.markReplaced(reading.pageId);
      replaced.push(reading.pageId);
    }
    const pageId = randomBytes(16).toString('base64url');
    this.readings.set(pageId, { pageId, project, overview, readAt: this.now() });
    while (this.readings.size > MAX_KEPT_READINGS) this.readings.delete(this.readings.keys().next().value!);
    return { pageId, replaced };
  }

  /** The reading a page shows, or undefined when it was dropped, replaced or never existed. */
  get(pageId: string): KeptReading | undefined {
    this.prune();
    return this.readings.get(pageId);
  }

  state(pageId: string): PageState {
    return this.replaced.has(pageId) ? 'replaced' : 'current';
  }

  private markReplaced(pageId: string): void {
    this.replaced.add(pageId);
    while (this.replaced.size > MAX_REPLACED_IDS) this.replaced.delete(this.replaced.values().next().value!);
  }

  private prune(): void {
    const oldest = this.now().getTime() - READING_TTL_MS;
    for (const [id, reading] of this.readings) if (reading.readAt.getTime() <= oldest) this.readings.delete(id);
  }
}
