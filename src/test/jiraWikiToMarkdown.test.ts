import { describe, it, expect } from 'vitest';
import { applyInline, jiraWikiToMarkdown } from '../utils/jiraWikiToMarkdown';

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
