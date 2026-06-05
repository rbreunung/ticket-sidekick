import { describe, it, expect } from 'vitest';
import { applyInline, jiraWikiToMarkdown } from '../utils/jiraWikiToMarkdown';

describe('jiraWikiToMarkdown — torture cases (#2 regression lock)', () => {
  it('handles bold inside a list item', () => {
    expect(jiraWikiToMarkdown('* normal *bold* item')).toBe('- normal **bold** item');
  });

  it('handles bold and monospace combined on one line', () => {
    expect(jiraWikiToMarkdown('*bold* and {{mono}}')).toBe('**bold** and `mono`');
  });

  it('handles a nested mixed ordered/unordered list', () => {
    const wiki = '* item1\n** sub\n# one';
    expect(jiraWikiToMarkdown(wiki)).toBe('- item1\n  - sub\n1. one');
  });

  it('protects a pipe inside a table-cell link', () => {
    const wiki = '||H1||H2||\n|[text|http://x]|b|';
    const md = jiraWikiToMarkdown(wiki);
    expect(md).toContain('[text](http://x)');
    // The link pipe must not split the row into an extra column.
    expect(md.split('\n').pop()).toBe('| [text](http://x) | b |');
  });

  it('handles strikethrough flanked by spaces', () => {
    expect(jiraWikiToMarkdown('a -strike- b')).toBe('a ~~strike~~ b');
  });

  it('keeps wiki markup verbatim inside a code block', () => {
    const wiki = '{code:java}if (*x*) return {{y}};{code}';
    const md = jiraWikiToMarkdown(wiki);
    expect(md).toContain('```java');
    expect(md).toContain('if (*x*) return {{y}};'); // not converted to ** or `
  });

  it('renders a panel title as bold and inline-converts the body', () => {
    expect(jiraWikiToMarkdown('{panel:title=Note}body *bold*{panel}')).toBe('**Note**\nbody **bold**');
  });

  it('applies inline conversions inside a heading', () => {
    expect(jiraWikiToMarkdown('h2. *Title* {{mono}}')).toBe('## **Title** `mono`');
  });
});

describe('applyInline — attachment patterns', () => {
  it('converts !filename.png! to an inline image', () => {
    expect(applyInline('See !screenshot.png!')).toBe('See ![screenshot.png](screenshot.png)');
  });

  it('strips thumbnail params from !filename|thumbnail!', () => {
    expect(applyInline('!screenshot.png|thumbnail!')).toBe('![screenshot.png](screenshot.png)');
  });

  it('strips arbitrary params after pipe', () => {
    expect(applyInline('!diagram.png|width=400,align=center!')).toBe('![diagram.png](diagram.png)');
  });

  it('converts [^filename] to a relative link', () => {
    expect(applyInline('[^error.log]')).toBe('[error.log](error.log)');
  });

  it('converts [^filename] with extension-free name', () => {
    expect(applyInline('[^patch]')).toBe('[patch](patch)');
  });

  it('leaves external image URLs intact (not rewritten to relative)', () => {
    const result = applyInline('!https://example.com/img.png!');
    expect(result).toBe('![https://example.com/img.png](https://example.com/img.png)');
  });
});

describe('jiraWikiToMarkdown — attachment markup in full documents', () => {
  it('converts inline image attachment in a paragraph', () => {
    const result = jiraWikiToMarkdown('See the attached image: !screenshot.png!');
    expect(result).toContain('![screenshot.png](screenshot.png)');
  });

  it('converts attachment link in a paragraph', () => {
    const result = jiraWikiToMarkdown('Download the log: [^error.log]');
    expect(result).toContain('[error.log](error.log)');
  });

  it('does not corrupt code blocks containing exclamation marks', () => {
    const result = jiraWikiToMarkdown('{code}assert(!value);{code}');
    expect(result).toContain('assert(!value)');
    expect(result).not.toContain('![');
  });
});
