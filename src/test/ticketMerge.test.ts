import { describe, it, expect } from 'vitest';
import { mergedSummary, mergedBanner } from '../utils/ticketMerge';

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
