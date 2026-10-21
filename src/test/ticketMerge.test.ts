import { describe, it, expect } from 'vitest';
import { mergedSummary, mergedBanner, resolveMergeSides, buildMergePlan, hasUnfinishedChoices } from '../utils/ticketMerge';
import type { ReviewRowBase } from '../participant/sessionState';

describe('mergedSummary', () => {
  it('prefixes a plain summary', () => {
    expect(mergedSummary('Netty', 'PROJ-12')).toBe('[Merged into PROJ-12] Netty');
  });

  it('leaves a summary that already names the same survivor unchanged', () => {
    expect(mergedSummary('[Merged into PROJ-12] Netty', 'PROJ-12')).toBe('[Merged into PROJ-12] Netty');
  });

  it('replaces the prefix of a different survivor', () => {
    expect(mergedSummary('[Merged into PROJ-7] Netty', 'PROJ-12')).toBe('[Merged into PROJ-12] Netty');
  });

  it('trims only the old summary to stay within 255 characters', () => {
    const out = mergedSummary('y'.repeat(300), 'PROJ-12');
    expect(out).toHaveLength(255);
    expect(out.startsWith('[Merged into PROJ-12] ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('mergedBanner', () => {
  it('puts a banner naming the survivor above the old body', () => {
    const out = mergedBanner('h1. Title\ntext', 'PROJ-12');
    expect(out.startsWith('{panel:title=Merged into PROJ-12}')).toBe(true);
    expect(out.endsWith('\nh1. Title\ntext')).toBe(true);
  });

  it('is added once: the same survivor leaves the description unchanged', () => {
    const once = mergedBanner('body', 'PROJ-12');
    expect(mergedBanner(once, 'PROJ-12')).toBe(once);
  });

  it('replaces the banner of another survivor and keeps a body that starts with a wiki heading', () => {
    const once = mergedBanner('h2. Heading\nrest', 'PROJ-7');
    const twice = mergedBanner(once, 'PROJ-12');
    expect(twice).not.toContain('PROJ-7');
    expect(twice.endsWith('\nh2. Heading\nrest')).toBe(true);
  });

  it('writes the banner alone for an empty or missing body', () => {
    expect(mergedBanner('', 'PROJ-12')).toMatch(/^\{panel:title=Merged into PROJ-12\}[\s\S]*\{panel\}$/);
    expect(mergedBanner(null, 'PROJ-12')).toBe(mergedBanner('', 'PROJ-12'));
  });
});


const ticketed = (id: string, key: string, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({
  id, existingTicketKey: key, included: false, target: { key, status: 'Open', resolved: false },
  action: 'leave', defaultAction: 'leave', ...extra,
});
const fresh = (id: string, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({ id, existingTicketKey: null, included: true, ...extra });

describe('resolveMergeSides', () => {
  const rows = [ticketed('A3', 'PROJ-12'), ticketed('A5', 'PROJ-15'), ticketed('A6', 'PROJ-15'), ticketed('A8', 'PROJ-18')];

  it('maps A ids to the tickets their rows point to and keeps a typed key, upper-cased', () => {
    expect(resolveMergeSides(rows, ['A5', 'proj-18'], 'A3')).toEqual({ ok: true, survivor: 'PROJ-12', sources: ['PROJ-15', 'PROJ-18'] });
  });

  it('collapses two ids that point to the same ticket into one source', () => {
    expect(resolveMergeSides(rows, ['A5', 'A6'], 'A3')).toEqual({ ok: true, survivor: 'PROJ-12', sources: ['PROJ-15'] });
  });

  it('refuses the same ticket on both sides', () => {
    const out = resolveMergeSides(rows, ['A5'], 'PROJ-15');
    expect(out.ok).toBe(false);
  });

  it('refuses an id that is not an Already-ticketed row, a malformed key and a New row id', () => {
    for (const ref of ['A9', 'NOTAKEY', '2']) {
      const out = resolveMergeSides([...rows, fresh('2')], [ref], 'A3');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(ref);
    }
  });

  it('refuses more than 50 sources', () => {
    const refs = Array.from({ length: 51 }, (_, i) => `PROJ-${100 + i}`);
    expect(resolveMergeSides(rows, refs, 'A3').ok).toBe(false);
  });

  it('refuses when no report row points to the survivor or to any source', () => {
    const out = resolveMergeSides(rows, ['PROJ-41'], 'PROJ-40');
    expect(out.ok).toBe(false);
  });

  it('accepts a survivor without rows when a source has rows', () => {
    expect(resolveMergeSides(rows, ['A5'], 'PROJ-40')).toEqual({ ok: true, survivor: 'PROJ-40', sources: ['PROJ-15'] });
  });

  it('accepts a source without rows when the survivor has rows', () => {
    expect(resolveMergeSides(rows, ['PROJ-41'], 'A3')).toEqual({ ok: true, survivor: 'PROJ-12', sources: ['PROJ-41'] });
  });

  it('resolves an id of a finished row too', () => {
    const done = ticketed('A5', 'PROJ-15', { result: { status: 'done', action: 'update' } });
    expect(resolveMergeSides([ticketed('A3', 'PROJ-12'), done], ['A5'], 'A3')).toMatchObject({ ok: true, sources: ['PROJ-15'] });
  });
});

describe('buildMergePlan', () => {
  it('runs the survivor first, then each source link and rewrite, and every close last', () => {
    const plan = buildMergePlan('PROJ-12', ['PROJ-15', 'PROJ-18']);
    expect(plan.map(s => `${s.kind}:${s.key}`)).toEqual([
      'survivor-rewrite:PROJ-12', 'survivor-comment:PROJ-12',
      'link:PROJ-15', 'source-rewrite:PROJ-15', 'link:PROJ-18', 'source-rewrite:PROJ-18',
      'close:PROJ-15', 'close:PROJ-18',
    ]);
    expect(plan.every(s => s.status === 'pending')).toBe(true);
  });
});

describe('hasUnfinishedChoices', () => {
  const session = (rows: ReviewRowBase[], allRows: ReviewRowBase[] = rows) => ({ rows, allRows });

  it('is false for a fresh session', () => {
    expect(hasUnfinishedChoices(session([fresh('1'), ticketed('A1', 'PROJ-1')]))).toBe(false);
  });

  it('is true when a New row on the displayed page is excluded, though allRows still holds the default', () => {
    const rows = [fresh('1', { included: false })];
    expect(hasUnfinishedChoices(session(rows, [fresh('1')]))).toBe(true);
  });

  it('is true when New rows are merged on the displayed page', () => {
    expect(hasUnfinishedChoices(session([fresh('1', { memberIds: ['1', '2'] })], [fresh('1'), fresh('2')]))).toBe(true);
  });

  it('is true when an unfinished Already-ticketed row was moved off its default action', () => {
    const moved = ticketed('A1', 'PROJ-1', { action: 'rewrite', defaultAction: 'update' });
    expect(hasUnfinishedChoices(session([moved]))).toBe(true);
  });

  it('is false when only a finished row differs from its default', () => {
    const done = ticketed('A1', 'PROJ-1', { action: 'rewrite', defaultAction: 'update', result: { status: 'done', action: 'rewrite' } });
    expect(hasUnfinishedChoices(session([done]))).toBe(false);
  });
});
