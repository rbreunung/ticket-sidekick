import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';

describe('htmlToMarkdown', () => {
  it('converts headings h1-h3', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toBe('## Sub');
    expect(htmlToMarkdown('<h3>Sub</h3>')).toBe('### Sub');
  });

  it('converts bold and italic', () => {
    expect(htmlToMarkdown('<b>bold</b>')).toBe('**bold**');
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlToMarkdown('<i>italic</i>')).toBe('_italic_');
    expect(htmlToMarkdown('<em>italic</em>')).toBe('_italic_');
  });

  it('converts unordered lists', () => {
    const html = '<ul><li>one</li><li>two</li></ul>';
    expect(htmlToMarkdown(html)).toBe('- one\n- two');
  });

  it('converts ordered lists', () => {
    const html = '<ol><li>first</li><li>second</li></ol>';
    expect(htmlToMarkdown(html)).toBe('1. first\n2. second');
  });

  it('converts a simple GFM table', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('| A | B |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('converts fenced code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toContain('```\nconst x = 1;\n```');
  });

  it('converts inline code', () => {
    expect(htmlToMarkdown('<code>foo()</code>')).toBe('`foo()`');
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://example.com">click</a>')).toBe('[click](https://example.com)');
  });

  it('replaces cid: inline images using the map', () => {
    const map = new Map([['abc123@host', 'screenshot.png']]);
    const html = '<img src="cid:abc123@host" />';
    expect(htmlToMarkdown(html, map)).toBe('[📎 screenshot.png]');
  });

  it('uses contentId as fallback when not in map', () => {
    const html = '<img src="cid:unknown@host" />';
    expect(htmlToMarkdown(html)).toBe('[📎 unknown@host]');
  });

  it('strips script and style blocks', () => {
    const html = '<style>.x{color:red}</style><p>Text</p><script>alert(1)</script>';
    expect(htmlToMarkdown(html)).toBe('Text');
  });

  it('decodes common HTML entities', () => {
    expect(htmlToMarkdown('&amp; &lt; &gt; &nbsp; &quot;')).toBe('& < >   "');
  });

  it('converts paragraphs to double newlines', () => {
    const result = htmlToMarkdown('<p>First</p><p>Second</p>');
    expect(result).toBe('First\n\nSecond');
  });

  it('converts data-ts-filename img to markdown image at correct position', () => {
    const html = '<p>Before</p><img data-ts-filename="email-image-1.png"><p>After</p>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('![email-image-1.png](email-image-1.png)');
    expect(result.indexOf('Before')).toBeLessThan(result.indexOf('![email-image-1.png]'));
    expect(result.indexOf('![email-image-1.png]')).toBeLessThan(result.indexOf('After'));
  });

  it('data-ts-filename img is not caught by the alt-text fallback', () => {
    const html = '<img data-ts-filename="photo.jpg" alt="photo">';
    expect(htmlToMarkdown(html)).toBe('![photo.jpg](photo.jpg)');
  });

  it('data-ts-filename takes precedence over src attribute', () => {
    const html = '<img src="https://example.com/img.png" data-ts-filename="email-image-2.png">';
    expect(htmlToMarkdown(html)).toBe('![email-image-2.png](email-image-2.png)');
  });
});
