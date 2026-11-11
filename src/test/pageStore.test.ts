import { describe, it, expect } from 'vitest';
import { MAX_KEPT_READINGS, PageStore, READING_TTL_MS } from '../canvas/securityReport/pageStore';
import type { Overview } from '../utils/securityOverview';

// The readings open security report pages show: held in memory for their Save, dropped after an
// hour or past ten, and an older page of the same project marked replaced.

const overview = (ticketCount: number): Overview => ({ tables: [], ticketCount, bySource: { veracode: ticketCount, waltz: 0 }, hasReport: false, unreadCount: 0 });

function clock() {
  let now = Date.parse('2026-11-11T10:00:00Z');
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

describe('the page store', () => {
  it('keeps a reading under a new page id', () => {
    const store = new PageStore();
    const { pageId } = store.add('PROJ', overview(12));
    expect(pageId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(store.get(pageId)).toMatchObject({ project: 'PROJ', overview: overview(12) });
    expect(store.state(pageId)).toBe('current');
  });

  it('marks an older page of the same project replaced, and leaves other projects alone', () => {
    const store = new PageStore();
    const first = store.add('PROJ', overview(1)).pageId;
    const other = store.add('PAY', overview(2)).pageId;
    const second = store.add('PROJ', overview(3));
    expect(second.replaced).toEqual([first]);
    expect(store.state(first)).toBe('replaced');
    expect(store.get(first)).toBeUndefined();
    expect(store.state(other)).toBe('current');
    expect(store.get(other)).toBeDefined();
  });

  it('does not mark a page replaced by its own refresh', () => {
    const store = new PageStore();
    const first = store.add('PROJ', overview(1)).pageId;
    const refreshed = store.add('PROJ', overview(2), first);
    expect(refreshed.replaced).toEqual([]);
    expect(store.state(first)).toBe('current');
    expect(store.get(first)).toBeUndefined();
    expect(store.get(refreshed.pageId)?.overview.ticketCount).toBe(2);
  });

  it('drops a reading after an hour', () => {
    const c = clock();
    const store = new PageStore(c.now);
    const { pageId } = store.add('PROJ', overview(1));
    c.advance(READING_TTL_MS - 1);
    expect(store.get(pageId)).toBeDefined();
    c.advance(1);
    expect(store.get(pageId)).toBeUndefined();
    expect(store.state(pageId)).toBe('current');
  });

  it('keeps at most ten readings, dropping the oldest', () => {
    const store = new PageStore();
    const ids = Array.from({ length: MAX_KEPT_READINGS + 1 }, (_, i) => store.add(`P${i}`, overview(i)).pageId);
    expect(store.get(ids[0])).toBeUndefined();
    expect(ids.slice(1).every(id => store.get(id) !== undefined)).toBe(true);
  });
});
