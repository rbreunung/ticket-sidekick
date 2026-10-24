import { describe, it, expect } from 'vitest';
import { mergedSummary, mergedBanner, resolveMergeSides, buildMergePlan, hasUnfinishedChoices, analyzeSourceMoves, buildCloseMergePlan, closeLinkType, survivorItemsLost, itemsOnNoTicket } from '../utils/ticketMerge';
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

describe('analyzeSourceMoves', () => {
  const toKey = (label: string) => (label.startsWith('v-') ? label.slice(2) : null);

  it('Covers AE3: a source whose items are all on the survivor moves nothing', () => {
    const [move] = analyzeSourceMoves({
      survivorLabels: ['veracode', 'v-1', 'v-2'], sources: [{ key: 'PROJ-9', labels: ['veracode', 'v-1', 'v-2'] }], labelToKey: toKey, droppedKeys: [],
    });
    expect(move).toEqual({ key: 'PROJ-9', movable: [], unlisted: [], elsewhere: [] });
  });

  it('Covers AE4: an item only the source records, which the rebuilt ticket still covers, is movable', () => {
    const [move] = analyzeSourceMoves({
      survivorLabels: ['v-1'], sources: [{ key: 'PROJ-9', labels: ['v-1', 'v-2', 'v-3'] }], labelToKey: toKey, droppedKeys: [],
    });
    expect(move.movable).toEqual(['2', '3']);
    expect(move.unlisted).toEqual([]);
  });

  it('Covers AE5: an item only the source records, which the report no longer lists, is unlisted', () => {
    const [move] = analyzeSourceMoves({
      survivorLabels: ['v-1'], sources: [{ key: 'PROJ-9', labels: ['v-1', 'v-2', 'v-3'] }], labelToKey: toKey, droppedKeys: ['3'],
    });
    expect(move).toEqual({ key: 'PROJ-9', movable: ['2'], unlisted: ['3'], elsewhere: [] });
  });

  it('Covers AE5: an item the rebuild does not cover but the unfiltered report still lists is elsewhere, not unlisted', () => {
    const [move] = analyzeSourceMoves({
      survivorLabels: ['v-1'], sources: [{ key: 'PROJ-9', labels: ['v-1', 'v-2', 'v-3'] }], labelToKey: toKey, droppedKeys: ['2', '3'], reportKeys: ['1', '2'],
    });
    expect(move).toEqual({ key: 'PROJ-9', movable: [], unlisted: ['3'], elsewhere: ['2'] });
  });

  it('judges each source on its own', () => {
    const moves = analyzeSourceMoves({
      survivorLabels: ['v-1'],
      sources: [{ key: 'PROJ-9', labels: ['v-1'] }, { key: 'PROJ-10', labels: ['v-1', 'v-4'] }],
      labelToKey: toKey, droppedKeys: [],
    });
    expect(moves.map(m => m.movable)).toEqual([[], ['4']]);
  });

  it('ignores labels that are not items', () => {
    const [move] = analyzeSourceMoves({
      survivorLabels: [], sources: [{ key: 'PROJ-9', labels: ['veracode', 'team-x'] }], labelToKey: toKey, droppedKeys: [],
    });
    expect(move).toEqual({ key: 'PROJ-9', movable: [], unlisted: [], elsewhere: [] });
  });
});

describe('survivorItemsLost', () => {
  const toKey = (l: string) => (l.startsWith('v-') ? l.slice(2) : null);

  it('names the kept ticket\'s own items that a rebuild from the report would stop showing', () => {
    expect(survivorItemsLost(['veracode', 'v-1', 'v-998'], toKey, ['998', '5'])).toEqual({ unlisted: ['998'], elsewhere: [] });
  });

  it('Covers AE5: separates items the report still lists from items it no longer lists', () => {
    expect(survivorItemsLost(['v-1', 'v-2', 'v-3'], toKey, ['2', '3'], ['1', '2'])).toEqual({ unlisted: ['3'], elsewhere: ['2'] });
  });
});

describe('itemsOnNoTicket', () => {
  const toKey = (l: string) => (l.startsWith('v-') ? l.slice(2) : null);

  it('names report items that no ticket in the merge records yet', () => {
    expect(itemsOnNoTicket(['1', '2', '3'], ['veracode', 'v-1', 'v-2'], toKey)).toEqual(['3']);
  });

  it('is empty when every item is already recorded', () => {
    expect(itemsOnNoTicket(['1', '1'], ['v-1'], toKey)).toEqual([]);
  });
});

describe('closeLinkType', () => {
  const both = ['Blocks', 'Duplicate', 'Relates'];

  it('Covers AE3: Duplicate when nothing moved', () => {
    expect(closeLinkType(false, both)).toBe('Duplicate');
  });

  it('Covers AE4: Relates when items moved', () => {
    expect(closeLinkType(true, both)).toBe('Relates');
  });

  it('falls back to the other type when the project has only one of them', () => {
    expect(closeLinkType(false, ['Relates'])).toBe('Relates');
    expect(closeLinkType(true, ['duplicate'])).toBe('Duplicate');
  });

  it('keeps the wanted type when the list says neither exists, so the link step reports the refusal', () => {
    expect(closeLinkType(true, [])).toBe('Relates');
    expect(closeLinkType(false, [])).toBe('Duplicate');
  });
});

describe('buildCloseMergePlan', () => {
  it('Covers AE3: with nothing to move the steps are link, comment, close per source — no rewrite', () => {
    const steps = buildCloseMergePlan('PROJ-1', [{ key: 'PROJ-9', movable: [], unlisted: [], elsewhere: [] }], ['Duplicate']);
    expect(steps.map(s => `${s.kind}:${s.key}`)).toEqual(['link:PROJ-9', 'source-comment:PROJ-9', 'close:PROJ-9']);
    expect(steps[0].linkType).toBe('Duplicate');
    expect(steps[0].wantedLinkType).toBe('Duplicate');
  });

  it('Covers AE4: items to move put the survivor rewrite first and use Relates for that source only', () => {
    const steps = buildCloseMergePlan('PROJ-1', [
      { key: 'PROJ-9', movable: ['2'], unlisted: [], elsewhere: [] },
      { key: 'PROJ-10', movable: [], unlisted: [], elsewhere: [] },
    ], ['Duplicate', 'Relates']);
    expect(steps.map(s => `${s.kind}:${s.key}`)).toEqual([
      'survivor-rewrite:PROJ-1', 'link:PROJ-9', 'source-comment:PROJ-9', 'link:PROJ-10', 'source-comment:PROJ-10', 'close:PROJ-9', 'close:PROJ-10',
    ]);
    expect(steps.filter(s => s.kind === 'link').map(s => s.linkType)).toEqual(['Relates', 'Duplicate']);
  });

  it('records the wanted link type apart from the fallback the project forces', () => {
    const [link] = buildCloseMergePlan('PROJ-1', [{ key: 'PROJ-9', movable: ['2'], unlisted: [], elsewhere: [] }], ['Duplicate']).filter(s => s.kind === 'link');
    expect(link).toMatchObject({ wantedLinkType: 'Relates', linkType: 'Duplicate' });
  });

  it('Covers AE4: runs the rewrite for report items no ticket records yet, even with nothing to move', () => {
    const steps = buildCloseMergePlan('PROJ-1', [{ key: 'PROJ-9', movable: [], unlisted: [], elsewhere: [] }], ['Duplicate'], true);
    expect(steps.map(s => `${s.kind}:${s.key}`)).toEqual(['survivor-rewrite:PROJ-1', 'link:PROJ-9', 'source-comment:PROJ-9', 'close:PROJ-9']);
    expect(steps.find(s => s.kind === 'link')?.linkType).toBe('Duplicate');
  });

  it('runs no rewrite when the only difference is items the report no longer lists', () => {
    const steps = buildCloseMergePlan('PROJ-1', [{ key: 'PROJ-9', movable: [], unlisted: ['3'], elsewhere: [] }], ['Duplicate']);
    expect(steps.some(s => s.kind === 'survivor-rewrite')).toBe(false);
  });
});
