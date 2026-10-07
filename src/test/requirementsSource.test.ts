import { describe, it, expect } from 'vitest';
import {
  buildRequirementsSource,
  formatRequirementsSourceText,
  REQUIREMENTS_COMMENT_MAX_CHARS,
  REQUIREMENTS_COMMENTS_MAX_CHARS,
} from '../utils/requirementsSource';
import type { JiraComment } from '../jira/IJiraClient';
import { MockJiraClient } from './mocks/MockJiraClient';

const client = new MockJiraClient();

async function sourceFor(key: string) {
  const issue = await client.getIssue(key);
  const comments = await client.getAllComments(key);
  return buildRequirementsSource(issue, comments);
}

function comment(i: number, text: string, created: string): JiraComment {
  return { id: String(i), author: { displayName: `User ${i}` }, body: text, created };
}

describe('buildRequirementsSource', () => {
  it('keeps a bug report vague description and the comment that agrees the fix, newest first with author and date', async () => {
    const source = await sourceFor('REQ-2');
    expect(source.key).toBe('REQ-2');
    expect(source.descriptionText).toContain('double charge');
    expect(source.comments.map((c) => c.author)).toEqual(['Bob', 'Alice']);
    expect(source.comments[0].text).toContain('idempotency key');
    expect(source.comments[0].created).toBe('2026-09-03T14:30:00.000+0000');
    expect(source.omittedComments).toBe(0);
    expect(source.commentsUnavailable).toBe(false);
  });

  it('turns a wiki-markup description into readable text', async () => {
    const source = await sourceFor('REQ-1');
    expect(source.descriptionText).toContain('Retry up to 3 times');
    expect(source.descriptionText).not.toContain('h2.');
  });

  it('turns an ADF description object into readable text', () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Export must be CSV.' }] }] };
    const source = buildRequirementsSource({ id: '1', key: 'REQ-9', fields: { summary: 'S', description: adf } } as never, []);
    expect(source.descriptionText).toBe('Export must be CSV.');
  });

  it('gives an empty ticket only a summary, with no description or comments', async () => {
    const source = await sourceFor('REQ-4');
    expect(source.summary).toBe('Look into reporting');
    expect(source.descriptionText).toBe('');
    expect(source.comments).toEqual([]);
    const text = formatRequirementsSourceText(source);
    expect(text).toContain('Look into reporting');
    expect(text).toContain('(no description)');
    expect(text).not.toContain('Comments');
  });

  it('caps many long comments within the total budget, keeps the newest, and says how many older ones were left out', () => {
    const comments = Array.from({ length: 30 }, (_, i) =>
      comment(i + 1, `comment ${i + 1} ` + 'x'.repeat(900), `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000+0000`));
    // Dates ascend with i for the first 28; the last two wrap, so the newest is index 27 (day 28).
    const source = buildRequirementsSource({ id: '1', key: 'REQ-9', fields: { summary: 'S', description: 'd' } } as never, comments);
    const total = source.comments.reduce((n, c) => n + c.text.length, 0);
    expect(total).toBeLessThanOrEqual(REQUIREMENTS_COMMENTS_MAX_CHARS);
    expect(source.comments[0].text).toContain('comment 28 ');
    expect(source.omittedComments).toBe(30 - source.comments.length);
    expect(source.omittedComments).toBeGreaterThan(0);
    expect(formatRequirementsSourceText(source)).toContain(`${source.omittedComments} older comment`);
  });

  it('trims one very long comment with a visible marker', () => {
    const long = comment(1, 'y'.repeat(REQUIREMENTS_COMMENT_MAX_CHARS * 2), '2026-09-01T10:00:00.000+0000');
    const source = buildRequirementsSource({ id: '1', key: 'REQ-9', fields: { summary: 'S', description: 'd' } } as never, [long]);
    expect(source.comments[0].text.length).toBeLessThanOrEqual(REQUIREMENTS_COMMENT_MAX_CHARS + 20);
    expect(source.comments[0].text).toMatch(/\[trimmed\]$/);
  });

  it('trims a very long description with a visible marker and flags it', () => {
    const source = buildRequirementsSource({ id: '1', key: 'REQ-9', fields: { summary: 'S', description: 'z'.repeat(20000) } } as never, []);
    expect(source.truncatedDescription).toBe(true);
    expect(source.descriptionText).toMatch(/\[trimmed\]$/);
    expect(source.descriptionText.length).toBeLessThan(6100);
  });

  it('records that comments were unavailable when the caller says so', async () => {
    const issue = await client.getIssue('REQ-2');
    const source = buildRequirementsSource(issue, [], { commentsUnavailable: true });
    expect(source.commentsUnavailable).toBe(true);
    expect(formatRequirementsSourceText(source)).toContain('comments could not be read');
  });
});
