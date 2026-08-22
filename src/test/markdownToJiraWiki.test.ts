import { describe, it, expect } from 'vitest';
import { markdownToJiraWiki } from '../utils/markdownToJiraWiki';

describe('markdownToJiraWiki', () => {
  describe('headings', () => {
    it('converts h1', () => {
      expect(markdownToJiraWiki('# Title')).toBe('h1. Title');
    });
    it('converts h2', () => {
      expect(markdownToJiraWiki('## Section')).toBe('h2. Section');
    });
    it('converts h3', () => {
      expect(markdownToJiraWiki('### Sub')).toBe('h3. Sub');
    });
    it('does not convert heading markers inside text', () => {
      expect(markdownToJiraWiki('not a # heading')).toBe('not a # heading');
    });
  });

  describe('inline formatting', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToJiraWiki('this is **bold** text')).toBe('this is *bold* text');
    });
    it('converts __bold__ to *bold*', () => {
      expect(markdownToJiraWiki('this is __bold__ text')).toBe('this is *bold* text');
    });
    it('converts *italic* (single asterisk) to _italic_', () => {
      expect(markdownToJiraWiki('this is *italic* text')).toBe('this is _italic_ text');
    });
    it('leaves _italic_ (underscore) unchanged — already Jira syntax', () => {
      expect(markdownToJiraWiki('this is _italic_ text')).toBe('this is _italic_ text');
    });
    it('converts ~~strikethrough~~ to -strikethrough-', () => {
      expect(markdownToJiraWiki('~~removed~~')).toBe('-removed-');
    });
    it('converts inline code to {{code}}', () => {
      expect(markdownToJiraWiki('use `npm install` to install')).toBe('use {{npm install}} to install');
    });
    it('does not apply bold/italic inside inline code', () => {
      expect(markdownToJiraWiki('`**not bold**`')).toBe('{{**not bold**}}');
    });
    it('converts [text](url) links', () => {
      expect(markdownToJiraWiki('[Jira](https://example.com)')).toBe('[Jira|https://example.com]');
    });
    it('converts ![alt](url) images', () => {
      expect(markdownToJiraWiki('![diagram](https://example.com/img.png)')).toBe('!https://example.com/img.png!');
    });
    it('handles bold and italic in the same line without conflict', () => {
      expect(markdownToJiraWiki('**bold** and *italic*')).toBe('*bold* and _italic_');
    });
  });

  describe('code blocks', () => {
    it('converts fenced code block with language', () => {
      const md = '```java\npublic void main() {}\n```';
      expect(markdownToJiraWiki(md)).toBe('{code:java}\npublic void main() {}\n{code}');
    });
    it('converts fenced code block without language', () => {
      const md = '```\nsome code\n```';
      expect(markdownToJiraWiki(md)).toBe('{code}\nsome code\n{code}');
    });
    it('preserves content inside code block verbatim', () => {
      const md = '```xml\n<dependency>\n  <groupId>com.example</groupId>\n</dependency>\n```';
      expect(markdownToJiraWiki(md)).toBe('{code:xml}\n<dependency>\n  <groupId>com.example</groupId>\n</dependency>\n{code}');
    });
    it('converts ```noformat fence to {noformat} block', () => {
      const md = '```noformat\n2024-01-01 INFO started\n```';
      expect(markdownToJiraWiki(md)).toBe('{noformat}\n2024-01-01 INFO started\n{noformat}');
    });
    it('does not produce {code:noformat} for noformat fence', () => {
      const md = '```noformat\nlog line\n```';
      expect(markdownToJiraWiki(md)).not.toContain('{code:noformat}');
    });
  });

  describe('lists', () => {
    it('converts unordered list with -', () => {
      expect(markdownToJiraWiki('- item one\n- item two')).toBe('* item one\n* item two');
    });
    it('converts unordered list with *', () => {
      expect(markdownToJiraWiki('* item one\n* item two')).toBe('* item one\n* item two');
    });
    it('converts nested unordered list', () => {
      const md = '- parent\n  - child';
      expect(markdownToJiraWiki(md)).toBe('* parent\n** child');
    });
    it('converts ordered list', () => {
      expect(markdownToJiraWiki('1. first\n2. second')).toBe('# first\n# second');
    });
    it('converts nested ordered list', () => {
      const md = '1. first\n   1. nested';
      expect(markdownToJiraWiki(md)).toBe('# first\n## nested');
    });
  });

  describe('blockquotes', () => {
    it('wraps single-line blockquote in {quote}', () => {
      expect(markdownToJiraWiki('> some quoted text')).toBe('{quote}\nsome quoted text\n{quote}');
    });
    it('wraps multi-line blockquote in a single {quote} block', () => {
      const md = '> line one\n> line two';
      expect(markdownToJiraWiki(md)).toBe('{quote}\nline one\nline two\n{quote}');
    });
  });

  describe('horizontal rules', () => {
    it('converts --- to ----', () => {
      expect(markdownToJiraWiki('---')).toBe('----');
    });
    it('converts *** to ----', () => {
      expect(markdownToJiraWiki('***')).toBe('----');
    });
  });

  describe('tables', () => {
    it('converts table header row with || delimiters', () => {
      const md = '| Col A | Col B |\n| --- | --- |\n| val 1 | val 2 |';
      const expected = '||Col A||Col B||\n|val 1|val 2|';
      expect(markdownToJiraWiki(md)).toBe(expected);
    });
    it('converts table body rows with | delimiters', () => {
      const md = '| Col A | Col B |\n| --- | --- |\n| val 1 | val 2 |\n| val 3 | val 4 |';
      const expected = '||Col A||Col B||\n|val 1|val 2|\n|val 3|val 4|';
      expect(markdownToJiraWiki(md)).toBe(expected);
    });
  });

  describe('passthrough', () => {
    it('leaves plain text unchanged', () => {
      expect(markdownToJiraWiki('just plain text')).toBe('just plain text');
    });
    it('preserves blank lines', () => {
      expect(markdownToJiraWiki('para one\n\npara two')).toBe('para one\n\npara two');
    });
  });

  describe('images', () => {
    it('converts local image (no protocol) to Jira thumbnail syntax', () => {
      expect(markdownToJiraWiki('![email-image-1.png](email-image-1.png)')).toBe('!email-image-1.png|thumbnail!');
    });

    it('converts remote image (https) to plain Jira image syntax without thumbnail', () => {
      expect(markdownToJiraWiki('![logo](https://example.com/logo.png)')).toBe('!https://example.com/logo.png!');
    });
  });

  describe('render safety', () => {
    it('neutralizes a raw, attacker-typed -struck- sequence (not produced by any Markdown construct)', () => {
      const out = markdownToJiraWiki('see -struck- here');
      expect(out).not.toContain('-struck-');
    });

    it('neutralizes a raw, attacker-typed +underline+ sequence', () => {
      const out = markdownToJiraWiki('see +underline+ here');
      expect(out).not.toContain('+underline+');
    });

    it('neutralizes a raw, attacker-typed ^super^ sequence', () => {
      const out = markdownToJiraWiki('see ^super^ here');
      expect(out).not.toContain('^super^');
    });

    it('neutralizes a raw, attacker-typed ??cite?? sequence', () => {
      const out = markdownToJiraWiki('see ??cite?? here');
      expect(out).not.toContain('??cite??');
    });

    it('neutralizes a raw !url! remote-image-embed sequence — the tracking-pixel exploit', () => {
      const out = markdownToJiraWiki('see !http://evil.example/t.gif! here');
      expect(out).not.toContain('!http://evil.example/t.gif!');
    });

    // Accepted, low-cost prose trade-off (KTD3): a footnote-style {1} loses its braces. This is
    // deliberate — see the cross-line macro test below for why unconditional stripping is required.
    it('strips a raw, unmatched single { or } in ordinary text (accepted prose trade-off)', () => {
      expect(markdownToJiraWiki('see note {1} above')).toBe('see note 1 above');
      expect(markdownToJiraWiki('close brace } stray')).toBe('close brace  stray');
    });

    it('does not let a {quote} macro pair split across two lines survive as a live macro in the joined output', () => {
      const md = 'intro {quote}\nhidden malicious content\n{quote} outro';
      const out = markdownToJiraWiki(md);
      expect(out).not.toContain('{quote}');
    });

    it('AE5: distinguishes legitimate ~~real~~ strikethrough from a raw same-shape -fake- on the same line', () => {
      const out = markdownToJiraWiki('legit ~~real~~ and raw -fake- here');
      // Legitimate Markdown strikethrough still converts to a live Jira strikethrough trigger.
      expect(out).toContain('-real-');
      // The raw, attacker-typed sequence must NOT survive as a live Jira strikethrough trigger,
      // even though after naive conversion the two would be byte-identical strings.
      expect(out).not.toContain('-fake-');
    });

    it('AE6: a Jira-native trigger inside a Markdown code span survives as literal, non-live text (relies on Jira not re-interpreting wiki markup inside its own {{...}} monospace macro — not verified against a live Jira instance here)', () => {
      const out = markdownToJiraWiki('`!http://attacker.example/t.gif!`');
      expect(out).toBe('{{!http://attacker.example/t.gif!}}');
    });

    it('leaves a fenced code block containing a Jira-native trigger completely untouched', () => {
      const md = '```\n!http://attacker.example/t.gif!\n```';
      expect(markdownToJiraWiki(md)).toBe('{code}\n!http://attacker.example/t.gif!\n{code}');
    });

    it('leaves bare, unwrapped -, +, ^, ?, ! characters in ordinary prose completely unaltered', () => {
      expect(markdownToJiraWiki('my co-worker computed x^2 today')).toBe('my co-worker computed x^2 today');
      expect(markdownToJiraWiki('what? really great!')).toBe('what? really great!');
    });

    it('leaves multi-hyphen compound-word prose unaltered — a naive -text- shape must not match between two compound-word hyphens', () => {
      expect(markdownToJiraWiki('a state-of-the-art solution')).toBe('a state-of-the-art solution');
      expect(markdownToJiraWiki('a well-known-issue in the field')).toBe('a well-known-issue in the field');
    });

    it('leaves a spaced date-range hyphen unaltered — not a strikethrough wrap', () => {
      expect(markdownToJiraWiki('open Monday - Friday hours')).toBe('open Monday - Friday hours');
    });
  });
});
