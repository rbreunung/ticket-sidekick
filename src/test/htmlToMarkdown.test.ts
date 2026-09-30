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

  it('converts data-ts-filename img to an attachment marker at correct position', () => {
    const html = '<p>Before</p><img data-ts-filename="email-image-1.png"><p>After</p>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('[📎 email-image-1.png]');
    expect(result.indexOf('Before')).toBeLessThan(result.indexOf('[📎 email-image-1.png]'));
    expect(result.indexOf('[📎 email-image-1.png]')).toBeLessThan(result.indexOf('After'));
  });

  it('data-ts-filename img is not caught by the alt-text fallback', () => {
    const html = '<img data-ts-filename="photo.jpg" alt="photo">';
    expect(htmlToMarkdown(html)).toBe('[📎 photo.jpg]');
  });

  it('data-ts-filename takes precedence over src attribute', () => {
    const html = '<img src="https://example.com/img.png" data-ts-filename="email-image-2.png">';
    expect(htmlToMarkdown(html)).toBe('[📎 email-image-2.png]');
  });

  it('trims whitespace inside bold when span wrapper adds leading newline', () => {
    // OWA pattern: <b><span ...>\ntext</span></b> — stripped span leaves **\ntext**
    const html = '<b><span class="x_style">\nBold sentence text.\n</span></b>';
    expect(htmlToMarkdown(html)).toBe('**Bold sentence text.**');
  });

  it('trims whitespace inside bold when nested block element creates indentation', () => {
    const html = '<strong>\n  Important notice.\n</strong>';
    expect(htmlToMarkdown(html)).toBe('**Important notice.**');
  });

  it('removes empty bold markers after whitespace trim', () => {
    const html = '<b>   </b>';
    expect(htmlToMarkdown(html)).toBe('');
  });

  it('preserves bold when no whitespace trimming is needed', () => {
    expect(htmlToMarkdown('<b>Normal bold</b>')).toBe('**Normal bold**');
  });

  it('normalizes Windows CRLF so output matches LF-only input', () => {
    const lf = htmlToMarkdown('<p>Line one</p><p>Line two</p>');
    const crlf = htmlToMarkdown('<p>Line one</p>\r\n<p>Line two</p>');
    expect(crlf).toBe(lf);
  });

  it('converts bare <pre> (no <code>) to ```noformat fence', () => {
    const result = htmlToMarkdown('<pre>2024-01-01 INFO started\n2024-01-01 WARN retry</pre>');
    expect(result).toContain('```noformat');
  });

  it('converts <pre><code> to plain ``` fence (not noformat)', () => {
    const result = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(result).not.toContain('noformat');
    expect(result).toContain('```');
  });

  describe('email line and image structure', () => {
    it('keeps an OWA reply header as four lines, each with its bold label', () => {
      const html = '<b>From:</b> Bob<br><b>Sent:</b> Mon<br><b>To:</b> Ann<br><b>Subject:</b> X';
      expect(htmlToMarkdown(html)).toBe('**From:** Bob\n**Sent:** Mon\n**To:** Ann\n**Subject:** X');
    });

    it('turns a div-per-line body into one line per div', () => {
      expect(htmlToMarkdown('<div>line 1</div><div>line 2</div>')).toBe('line 1\nline 2');
    });

    it('does not add blank lines for nested divs closing together', () => {
      expect(htmlToMarkdown('<div><div>line 1</div></div><div>line 2</div>')).toBe('line 1\nline 2');
    });

    it('breaks the line at a horizontal rule', () => {
      expect(htmlToMarkdown('Reply text<hr>Original message')).toBe('Reply text\nOriginal message');
    });

    it('lays a signature table cell out as separate lines with its cid: logo marker', () => {
      const map = new Map([['logo@host', 'logo.png']]);
      const html = '<table><tr><td><img src="cid:logo@host"></td>'
        + '<td><b>Jane Doe</b><br>Head of Operations<br>Tel: +1 555 0100</td></tr></table>';
      const lines = htmlToMarkdown(html, map).split('\n');
      expect(lines).toEqual(['[📎 logo.png]', '**Jane Doe**', 'Head of Operations', 'Tel: +1 555 0100']);
    });

    it('keeps the lines and image of a signature table nested inside a layout table', () => {
      const map = new Map([['logo@host', 'logo.png']]);
      const html = '<table><tr><td><p>Thanks</p>'
        + '<table><tr><td>Jane Doe<br>Head of Operations<br><img src="cid:logo@host"></td></tr></table>'
        + '</td></tr></table><p>Disclaimer</p>';
      const result = htmlToMarkdown(html, map);
      expect(result.split('\n').filter(l => l.trim())).toEqual(
        ['Thanks', 'Jane Doe', 'Head of Operations', '[📎 logo.png]', 'Disclaimer']);
      expect(result).not.toContain('|');
    });

    it('keeps images inside a data table cell as markers', () => {
      const html = '<table><tr><th>Name</th><th>Logo</th></tr>'
        + '<tr><td>Acme</td><td><img data-ts-filename="acme.png"></td></tr></table>';
      expect(htmlToMarkdown(html)).toContain('| Acme | [📎 acme.png] |');
    });

    it('still renders a plain data table with single-line cells as a Markdown table', () => {
      const html = '<table><thead><tr><th class="h">A</th><th>B</th></tr></thead>'
        + '<tbody><tr><td><span>1</span></td><td>2</td></tr></tbody></table>';
      expect(htmlToMarkdown(html)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
    });

    it('does not produce stray bold markers around a line break', () => {
      expect(htmlToMarkdown('Hi<br>there <b>Bob</b>')).toBe('Hi\nthere **Bob**');
    });

    it('bolds each line of a bold run that contains a line break', () => {
      expect(htmlToMarkdown('<b>Jane Doe<br>Head of Operations</b>')).toBe('**Jane Doe**\n**Head of Operations**');
    });

    it('does not treat <body>, <blockquote>, <img> or <embed> as bold/italic tags', () => {
      expect(htmlToMarkdown('<body>Hello</body>')).toBe('Hello');
      expect(htmlToMarkdown('<blockquote>Quoted</blockquote> <b>x</b>')).toBe('Quoted **x**');
      expect(htmlToMarkdown('<img src="cid:a@b"> text <i>it</i>')).toBe('[📎 a@b] text _it_');
      expect(htmlToMarkdown('<embed src="x"> text <em>it</em>')).toBe('text _it_');
    });

    it('still recognises bold and italic tags carrying attributes', () => {
      expect(htmlToMarkdown('<b class="x">bold</b> <em style="a">it</em>')).toBe('**bold** _it_');
    });
  });
});
