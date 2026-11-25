import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../review/reviewSessionState';
import { escapeMarkdown, formatShareMarkdown, formatShareTeams, markdownToPlain, type ShareInput } from '../review/shareFormat';

// The review board's Copy for Teams (plain text) and Copy as Markdown, built from the stored review.
// Finding and explanation text comes from a model: in plain text it loses its Markdown,
// in Markdown it is escaped so it shows as the characters it is.

function finding(id: number, extra: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id, file: `src/f${id}.ts`, line: 4, lineType: 'ADDED', severity: 'warning', confidence: 0.9,
    title: `Unchecked input ${id}`, description: 'described', recommendation: `Validate input ${id}`, ...extra,
  };
}

function input(extra: Partial<ShareInput> = {}): ShareInput {
  return {
    pr: { id: 482, title: 'Add export', author: { displayName: 'Jane Smith' } as ShareInput['pr']['author'], targetBranch: 'main' },
    url: 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482',
    findings: [finding(1), finding(2, { severity: 'critical' }), finding(3)],
    explanations: {},
    confidenceThreshold: 0.7,
    ...extra,
  };
}

describe('Copy for Teams', () => {
  it('copies the selected findings with their explanations, as plain text', () => {
    const { text, count } = formatShareTeams(input({
      targets: [3],
      explanations: { 3: '## Why\nThe value is **never** checked; see `parse()`.\n\n```ts\nparse(x)\n```', 1: 'Not copied' },
    }));
    expect(count).toBe(1);
    expect(text).toContain('PR #482 — Add export');
    expect(text).toContain('1 of 3 findings');
    expect(text).toContain('#3 ');
    expect(text).toContain('   Explanation:\n   Why\n   The value is never checked; see parse().\n\n   parse(x)');
    expect(text).not.toContain('Not copied');
    expect(text).not.toContain('Unchecked input 1');
    expect(text).not.toMatch(/\*\*|`|##/);
  });

  it('copies every finding when nothing is selected', () => {
    const { text, count } = formatShareTeams(input());
    expect(count).toBe(3);
    expect(text).toContain('3 findings');
    for (const n of [1, 2, 3]) expect(text).toContain(`Unchecked input ${n}`);
  });

  it('turns a Markdown link in model text into its words and address', () => {
    expect(markdownToPlain('See [the docs](https://example.com/x) and *this*.')).toBe('See the docs (https://example.com/x) and this.');
  });
});

describe('Copy as Markdown', () => {
  it('escapes finding text so a title with * and [ shows as written', () => {
    const { text } = formatShareMarkdown(input({ findings: [finding(1, { title: 'Use *any* [type] here' })] }));
    expect(text).toContain('Use \\*any\\* \\[type\\] here');
  });

  it('keeps a link, an image, a heading, a table row or HTML in model text from rendering', () => {
    const hostile = '[click](https://evil.example) ![x](https://evil.example/i.png) <img src=x> a | b';
    const { text } = formatShareMarkdown(input({
      findings: [finding(1, { title: hostile, file: 'src/`f`.ts' })],
      explanations: { 1: '# Heading\n- item\n1. step' },
    }));
    expect(text).not.toMatch(/(^|[^\\])\[click\]\(/);
    expect(text).not.toMatch(/(^|[^\\])<img/);
    expect(text).not.toMatch(/(^|[^\\])!\[/);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toMatch(/(^|[^\\])\|/);
    expect(text).not.toMatch(/(^|[^\\])`/);
    expect(text).toContain('\\# Heading');
    expect(text).toContain('\\- item');
    expect(text).toContain('1\\. step');
  });

  it('has the same content as the plain text: header, the selected findings and their explanations', () => {
    const { text, count } = formatShareMarkdown(input({
      targets: [2], explanations: { 2: 'Line one.\nLine two.' },
    }));
    expect(count).toBe(1);
    expect(text).toContain('**PR #482: Add export**');
    expect(text).toContain('1 of 3 findings');
    expect(text).toContain('**Critical (1)**');
    expect(text).toContain('**#2** src/f2.ts:L4: Unchecked input 2');
    expect(text).toContain('Line one.  \nLine two.');
    expect(text).not.toContain('Unchecked input 1');
  });

  it('escapes every character Markdown treats as syntax', () => {
    expect(escapeMarkdown('a*b_c`d[e]f#g|h<i>j\\k')).toBe('a\\*b\\_c\\`d\\[e\\]f\\#g\\|h\\<i\\>j\\\\k');
  });
});
